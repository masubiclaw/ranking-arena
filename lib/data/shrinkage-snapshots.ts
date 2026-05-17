/**
 * trader_shrinkage_snapshots + shrinkage_population_runs DAO.
 *
 * CRYAA-2137 — Supabase persistence for the empirical-Bayes shrinkage outputs
 * computed by the `compute-shrinkage` cron. See plan §D1 in
 * `docs/integration-ranking-arena/01-arena-service.md` for context.
 *
 * Public surface:
 *   - `insertBatch(rows, opts?)` — daily upsert of per-trader posteriors
 *     keyed by `(window, platform, trader_key, computed_at::date)`.
 *   - `latestForWindow(window, opts?)` — most recent row per
 *     `(platform, trader_key)` within the window, filtered by platform set
 *     and max snapshot age.
 *   - `newestComputedAt(window)` — newest `computed_at` for the window,
 *     used by `/health` to expose `shrinkage_cron_age_seconds`.
 *   - `findAtOrBefore(window, snapshotAt)` — closest-at-or-before snapshot
 *     for time-travel reads; returns `null` when no row exists before
 *     `snapshotAt`.
 *   - `insertPopulationRun(...)` / `latestPopulationRun(window)` for the
 *     companion `shrinkage_population_runs` table.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export type ShrinkageWindow = '7D' | '30D' | '90D'

export interface TraderShrinkageSnapshot {
  window: ShrinkageWindow | string
  platform: string
  trader_key: string
  observed: number | null
  shrunk: number | null
  posterior_sd: number | null
  weight_to_prior: number | null
  p_superforecaster: number | null
  mu_pop: number | null
  tau_sq: number | null
  eligible_n: number | null
  sf_threshold: number | null
  sf_fraction: number | null
  computed_at: string // ISO timestamp
}

export interface ShrinkagePopulationRun {
  window: ShrinkageWindow | string
  mu_pop: number | null
  tau_sq: number | null
  eligible_n: number | null
  sf_threshold: number | null
  sf_fraction: number | null
  median_trades: number | null
  computed_at: string
}

interface LatestForWindowOpts {
  platforms?: readonly string[]
  maxAgeSeconds?: number
  now?: Date
}

const TABLE = 'trader_shrinkage_snapshots'
const POP_TABLE = 'shrinkage_population_runs'

function getClient(client?: SupabaseClient): SupabaseClient {
  return client ?? getSupabaseAdmin()
}

/**
 * Upsert a batch of per-trader posterior rows. The unique key
 * `(window, platform, trader_key, computed_at::date)` is enforced by the
 * migration's partial index, so re-runs within the same UTC day overwrite
 * rather than accumulating duplicates.
 *
 * Returns the number of rows accepted by Supabase. Throws on driver error.
 */
export async function insertBatch(
  rows: readonly TraderShrinkageSnapshot[],
  opts: { client?: SupabaseClient } = {}
): Promise<number> {
  if (rows.length === 0) return 0
  const supabase = getClient(opts.client)
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(rows as TraderShrinkageSnapshot[], {
      onConflict: 'window,platform,trader_key,(computed_at AT TIME ZONE \'UTC\')::date',
      ignoreDuplicates: false,
    })
    .select('id')
  if (error) {
    throw new Error(`insertBatch failed: ${error.message}`)
  }
  return data?.length ?? rows.length
}

/**
 * Returns the most-recent snapshot per `(platform, trader_key)` within the
 * given window. Filtered by optional `platforms` whitelist and
 * `maxAgeSeconds` (snapshots strictly older than `now - maxAgeSeconds` are
 * excluded). When `maxAgeSeconds` is undefined no age filter is applied.
 *
 * Returns the rows in descending `computed_at` order; the cron read path
 * collapses duplicates client-side so this works without a `DISTINCT ON`
 * server-side (Supabase PostgREST does not expose `DISTINCT ON`).
 */
export async function latestForWindow(
  window: ShrinkageWindow | string,
  opts: LatestForWindowOpts & { client?: SupabaseClient } = {}
): Promise<TraderShrinkageSnapshot[]> {
  const supabase = getClient(opts.client)
  let q = supabase
    .from(TABLE)
    .select(
      'window, platform, trader_key, observed, shrunk, posterior_sd, weight_to_prior, p_superforecaster, mu_pop, tau_sq, eligible_n, sf_threshold, sf_fraction, computed_at'
    )
    .eq('window', window)
    .order('computed_at', { ascending: false })

  if (opts.platforms && opts.platforms.length > 0) {
    q = q.in('platform', opts.platforms as string[])
  }
  if (typeof opts.maxAgeSeconds === 'number' && opts.maxAgeSeconds > 0) {
    const cutoff = new Date(
      (opts.now ?? new Date()).getTime() - opts.maxAgeSeconds * 1000
    ).toISOString()
    q = q.gte('computed_at', cutoff)
  }

  const { data, error } = await q
  if (error) {
    throw new Error(`latestForWindow failed: ${error.message}`)
  }

  const rows = (data ?? []) as TraderShrinkageSnapshot[]
  // Collapse to newest row per (platform, trader_key) — rows already sorted desc.
  const seen = new Set<string>()
  const out: TraderShrinkageSnapshot[] = []
  for (const r of rows) {
    const k = `${r.platform}\x00${r.trader_key}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/**
 * Newest `computed_at` for the given window across all platforms, or `null`
 * if the table is empty for that window. Backing read for `/api/v1/health`'s
 * `shrinkage_cron_last_run` / `shrinkage_cron_age_seconds` fields.
 */
export async function newestComputedAt(
  window: ShrinkageWindow | string,
  opts: { client?: SupabaseClient } = {}
): Promise<string | null> {
  const supabase = getClient(opts.client)
  const { data, error } = await supabase
    .from(TABLE)
    .select('computed_at')
    .eq('window', window)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`newestComputedAt failed: ${error.message}`)
  }
  return (data as { computed_at?: string } | null)?.computed_at ?? null
}

/**
 * Time-travel read: returns the closest snapshot per `(platform, trader_key)`
 * with `computed_at <= snapshotAt`. Returns `null` when no row exists at or
 * before `snapshotAt` (consumer translates this to HTTP 404).
 */
export async function findAtOrBefore(
  window: ShrinkageWindow | string,
  snapshotAt: Date | string,
  opts: { client?: SupabaseClient; platforms?: readonly string[] } = {}
): Promise<TraderShrinkageSnapshot[] | null> {
  const supabase = getClient(opts.client)
  const cutoff = snapshotAt instanceof Date ? snapshotAt.toISOString() : snapshotAt

  let q = supabase
    .from(TABLE)
    .select(
      'window, platform, trader_key, observed, shrunk, posterior_sd, weight_to_prior, p_superforecaster, mu_pop, tau_sq, eligible_n, sf_threshold, sf_fraction, computed_at'
    )
    .eq('window', window)
    .lte('computed_at', cutoff)
    .order('computed_at', { ascending: false })

  if (opts.platforms && opts.platforms.length > 0) {
    q = q.in('platform', opts.platforms as string[])
  }

  const { data, error } = await q
  if (error) {
    throw new Error(`findAtOrBefore failed: ${error.message}`)
  }

  const rows = (data ?? []) as TraderShrinkageSnapshot[]
  if (rows.length === 0) return null

  const seen = new Set<string>()
  const out: TraderShrinkageSnapshot[] = []
  for (const r of rows) {
    const k = `${r.platform}\x00${r.trader_key}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

// ---- shrinkage_population_runs ---------------------------------------------

export async function insertPopulationRun(
  row: ShrinkagePopulationRun,
  opts: { client?: SupabaseClient } = {}
): Promise<void> {
  const supabase = getClient(opts.client)
  const { error } = await supabase
    .from(POP_TABLE)
    .upsert(row, {
      onConflict: 'window,(computed_at AT TIME ZONE \'UTC\')::date',
      ignoreDuplicates: false,
    })
  if (error) {
    throw new Error(`insertPopulationRun failed: ${error.message}`)
  }
}

export async function latestPopulationRun(
  window: ShrinkageWindow | string,
  opts: { client?: SupabaseClient } = {}
): Promise<ShrinkagePopulationRun | null> {
  const supabase = getClient(opts.client)
  const { data, error } = await supabase
    .from(POP_TABLE)
    .select('window, mu_pop, tau_sq, eligible_n, sf_threshold, sf_fraction, median_trades, computed_at')
    .eq('window', window)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`latestPopulationRun failed: ${error.message}`)
  }
  return (data as ShrinkagePopulationRun | null) ?? null
}

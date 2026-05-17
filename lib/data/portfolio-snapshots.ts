/**
 * trader_portfolio_snapshots DAO.
 *
 * CRYAA-2154 — Supabase persistence for hourly trader-portfolio snapshots.
 * The `persist-trader-portfolios` cron upserts the current open positions of
 * every eligible-pool trader (top-K by `p_superforecaster`); the live
 * `/api/v1/trader-portfolios` endpoint reads from this table when called with
 * `?snapshot_at=<iso>` so ACP's weekly forward-validation script can replay
 * cohort positions at T-N instead of relying on the upstream API.
 *
 * Public surface:
 *   - `insertBatch(rows, opts?)` — hourly upsert of per-trader snapshots
 *     keyed by `(platform, trader_key, hour-of-captured_at UTC)`.
 *   - `findAtOrBeforeBatch(req, snapshotAt, opts?)` — closest-at-or-before
 *     row per requested `(platform, trader_key)`. Returns a map keyed by
 *     `${platform}:${trader_key}` with `null` for traders without a snapshot
 *     before the cutoff (caller turns this into `ok: false, error: 'no_snapshot'`).
 *   - `latestForPlatform(platform, opts?)` — newest snapshot per trader_key
 *     within a platform; helper for ad-hoc reads.
 *   - `newestCapturedAt(opts?)` — newest `captured_at` across all rows,
 *     drives `/api/v1/health`'s `portfolio_snapshot_cron_age_seconds`.
 *   - `pruneOlderThan(days, opts?)` — retention helper; deletes rows older
 *     than `days * 86400` seconds.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export interface SnapshotPosition {
  symbol: string
  side: 'long' | 'short'
  size: number
  entry_price: number | null
  mark_price?: number | null
  leverage?: number | null
  notional_usd: number
  unrealized_pnl_usd?: number | null
  liq_price?: number | null
}

export interface TraderPortfolioSnapshot {
  platform: string
  trader_key: string
  captured_at: string // ISO timestamp
  account_value_usd?: number | null
  total_notional_usd?: number | null
  positions: SnapshotPosition[]
  source?: string | null
}

interface TraderRequest {
  platform: string
  trader_key: string
}

const TABLE = 'trader_portfolio_snapshots'

function getClient(client?: SupabaseClient): SupabaseClient {
  return client ?? getSupabaseAdmin()
}

function keyFor(row: TraderRequest): string {
  return `${row.platform}\x00${row.trader_key}`
}

/**
 * Upsert a batch of trader-portfolio snapshots. The unique key
 * `(platform, trader_key, date_trunc('hour', captured_at AT TIME ZONE 'UTC'))`
 * is enforced by the migration's partial index, so re-runs within the same
 * UTC hour overwrite the same trader's snapshot rather than duplicating.
 *
 * Returns the number of rows accepted. Throws on driver error.
 */
export async function insertBatch(
  rows: readonly TraderPortfolioSnapshot[],
  opts: { client?: SupabaseClient } = {}
): Promise<number> {
  if (rows.length === 0) return 0
  const supabase = getClient(opts.client)
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(rows as TraderPortfolioSnapshot[], {
      onConflict: "platform,trader_key,date_trunc('hour', captured_at AT TIME ZONE 'UTC')",
      ignoreDuplicates: false,
    })
    .select('id')
  if (error) {
    throw new Error(`insertBatch failed: ${error.message}`)
  }
  return data?.length ?? rows.length
}

/**
 * Time-travel batch read. For each requested `(platform, trader_key)`, return
 * the closest snapshot with `captured_at <= snapshotAt`, or `null` when no
 * snapshot exists at or before that timestamp.
 *
 * The returned map is keyed by `${platform}:${trader_key}` so callers can
 * iterate the input array preserving order without re-keying.
 */
export async function findAtOrBeforeBatch(
  requested: readonly TraderRequest[],
  snapshotAt: Date | string,
  opts: { client?: SupabaseClient } = {}
): Promise<Map<string, TraderPortfolioSnapshot | null>> {
  const out = new Map<string, TraderPortfolioSnapshot | null>()
  if (requested.length === 0) return out

  // Initialise every requested trader to null so callers see the miss.
  for (const r of requested) {
    out.set(`${r.platform}:${r.trader_key}`, null)
  }

  const supabase = getClient(opts.client)
  const cutoff = snapshotAt instanceof Date ? snapshotAt.toISOString() : snapshotAt

  // Group requested keys by platform — the unique index is (platform,
  // trader_key, hour) so one query per platform serves the cohort efficiently
  // and avoids a too-large `or=(…)` predicate.
  const byPlatform = new Map<string, string[]>()
  for (const r of requested) {
    const arr = byPlatform.get(r.platform) ?? []
    arr.push(r.trader_key)
    byPlatform.set(r.platform, arr)
  }

  for (const [platform, traderKeys] of byPlatform) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(
        'platform, trader_key, captured_at, account_value_usd, total_notional_usd, positions, source'
      )
      .eq('platform', platform)
      .in('trader_key', traderKeys)
      .lte('captured_at', cutoff)
      .order('captured_at', { ascending: false })
    if (error) {
      throw new Error(`findAtOrBeforeBatch failed: ${error.message}`)
    }
    const rows = (data ?? []) as TraderPortfolioSnapshot[]
    // Driver returned desc by captured_at — the first row per trader_key is
    // the closest at-or-before cutoff. Skip subsequent rows for the same key.
    const seen = new Set<string>()
    for (const r of rows) {
      const k = keyFor(r)
      if (seen.has(k)) continue
      seen.add(k)
      out.set(`${r.platform}:${r.trader_key}`, r)
    }
  }
  return out
}

/**
 * Latest snapshot per trader_key for a given platform. Caller may pass
 * `maxAgeSeconds` to exclude snapshots older than `now - maxAgeSeconds`.
 */
export async function latestForPlatform(
  platform: string,
  opts: {
    client?: SupabaseClient
    maxAgeSeconds?: number
    now?: Date
    limit?: number
  } = {}
): Promise<TraderPortfolioSnapshot[]> {
  const supabase = getClient(opts.client)
  let q = supabase
    .from(TABLE)
    .select(
      'platform, trader_key, captured_at, account_value_usd, total_notional_usd, positions, source'
    )
    .eq('platform', platform)
    .order('captured_at', { ascending: false })

  if (typeof opts.maxAgeSeconds === 'number' && opts.maxAgeSeconds > 0) {
    const cutoff = new Date(
      (opts.now ?? new Date()).getTime() - opts.maxAgeSeconds * 1000
    ).toISOString()
    q = q.gte('captured_at', cutoff)
  }
  if (typeof opts.limit === 'number' && opts.limit > 0) {
    q = q.limit(opts.limit)
  }

  const { data, error } = await q
  if (error) {
    throw new Error(`latestForPlatform failed: ${error.message}`)
  }
  const rows = (data ?? []) as TraderPortfolioSnapshot[]
  const seen = new Set<string>()
  const out: TraderPortfolioSnapshot[] = []
  for (const r of rows) {
    const k = keyFor(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/**
 * Newest `captured_at` across all rows, or `null` when the table is empty.
 * Backing read for `/api/v1/health`'s `portfolio_snapshot_cron_*` fields.
 */
export async function newestCapturedAt(
  opts: { client?: SupabaseClient } = {}
): Promise<string | null> {
  const supabase = getClient(opts.client)
  const { data, error } = await supabase
    .from(TABLE)
    .select('captured_at')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`newestCapturedAt failed: ${error.message}`)
  }
  return (data as { captured_at?: string } | null)?.captured_at ?? null
}

/**
 * Retention helper — deletes rows with `captured_at < now() - days*86400`.
 * The scope (CRYAA-2154 §retention) requires at least 90 days; the cron
 * passes `days = 90` so we keep a full forward-validation window plus the
 * warm-up grace ACP allows.
 */
export async function pruneOlderThan(
  days: number,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<number> {
  if (!(days > 0)) return 0
  const supabase = getClient(opts.client)
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - days * 86400 * 1000
  ).toISOString()
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .lt('captured_at', cutoff)
    .select('id')
  if (error) {
    throw new Error(`pruneOlderThan failed: ${error.message}`)
  }
  return data?.length ?? 0
}

/**
 * Centralized eligibility predicate for the arena shrinkage population.
 *
 * Replaces the ad-hoc "top 5000 by roi_pct desc with non-null max_drawdown"
 * prefilter that biased μ_pop upward for the shrunk Sharpe-vs-BTC metric.
 * Spec: CRYAA-2117. Implementation: CRYAA-2118.
 *
 * Predicate (final, board-approved):
 *   - `window = <window>` on `trader_snapshots_v2`
 *   - `updated_at >= NOW() - 24h` (active in window)
 *   - `trades_count >= 30` (sample-size floor matching the shrinkage prior's
 *     `medianTrades` anchor at `lib/utils/shrinkage.ts`)
 *   - `max_drawdown IS NOT NULL AND ABS(max_drawdown) >= 0.5` (pushes the
 *     silent downstream filter at `benchmark-sharpe.ts:53` into the SQL so
 *     `eligible_n` stops lying)
 *   - No ROI sort, no top-K cap. Ranking happens downstream after shrinkage.
 *
 * Both the live `/api/v1/top-traders` route (`source=live`) and the
 * `/superforecasters` page consume this helper. The pending D1 shrinkage
 * cron MUST consume it too (CEO condition 2 on CRYAA-2118).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ShrinkageWindow } from '@/lib/data/shrinkage-snapshots'

export const ARENA_POOL_DEFAULTS = {
  minTradesCount: 30,
  minAbsDrawdown: 0.5,
  activeWindowHours: 24,
} as const

export interface ArenaEligibleCriteria {
  window: ShrinkageWindow
  /** Lower bound on `updated_at`; rows older than this are excluded. */
  minUpdatedAt: Date
  /** Minimum `trades_count` (N). Defaults to 30 per CRYAA-2117. */
  minTradesCount?: number
  /** Drawdown floor (absolute value). Defaults to 0.5%. */
  minAbsDrawdown?: number
  /** Optional platform allowlist. */
  platforms?: string[]
  /**
   * Hard safety cap on the raw row pull before dedupe. Not a ranking cap.
   * Defaults to 100000, which is well above any realistic eligible pool.
   */
  rowFetchCap?: number
}

export interface ArenaEligibleRow {
  platform: string
  trader_key: string
  roi_pct: number | null
  pnl_usd: number | null
  max_drawdown: number | null
  trades_count: number | null
  arena_score: number | null
  sharpe_ratio: number | null
  updated_at: string
}

/**
 * Build the default `minUpdatedAt` (NOW − 24h) using the predicate's
 * active-window convention. Exposed so callers can stay consistent.
 */
export function defaultActiveSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - ARENA_POOL_DEFAULTS.activeWindowHours * 3600 * 1000)
}

/**
 * Fetch the eligible arena pool for shrinkage. Returns one row per
 * `(platform, trader_key)` (latest `updated_at` wins).
 *
 * Callers MUST NOT add an additional ROI sort or top-K cap to the result
 * before passing it to `estimatePopulation`; any output ranking belongs
 * after shrinkage.
 */
export async function fetchEligibleArenaPool(
  client: SupabaseClient,
  criteria: ArenaEligibleCriteria,
): Promise<ArenaEligibleRow[]> {
  const minTrades = criteria.minTradesCount ?? ARENA_POOL_DEFAULTS.minTradesCount
  const minAbsDd = criteria.minAbsDrawdown ?? ARENA_POOL_DEFAULTS.minAbsDrawdown
  const cap = criteria.rowFetchCap ?? 100000

  let q = client
    .from('trader_snapshots_v2')
    .select(
      'platform, trader_key, roi_pct, pnl_usd, max_drawdown, trades_count, arena_score, sharpe_ratio, updated_at',
    )
    .eq('window', criteria.window)
    .gte('updated_at', criteria.minUpdatedAt.toISOString())
    .gte('trades_count', minTrades)
    .not('max_drawdown', 'is', null)
    // ABS(max_drawdown) >= minAbsDd via two-sided OR.
    .or(`max_drawdown.gte.${minAbsDd},max_drawdown.lte.${-minAbsDd}`)
    // Order is for dedupe only — NOT a ranking sort.
    .order('updated_at', { ascending: false })
    .limit(cap)

  if (criteria.platforms && criteria.platforms.length > 0) {
    q = q.in('platform', criteria.platforms)
  }

  const { data, error } = await q
  if (error) {
    throw new Error(`fetchEligibleArenaPool failed: ${error.message}`)
  }

  return dedupeLatestPerTrader((data ?? []) as ArenaEligibleRow[])
}

/**
 * Pure in-memory variant of the eligibility predicate. Used by tests and by
 * any consumer that already has the rows in hand (e.g. snapshot replay).
 * Matches `fetchEligibleArenaPool` exactly.
 */
export function applyEligibilityPredicate(
  rows: readonly ArenaEligibleRow[],
  criteria: Omit<ArenaEligibleCriteria, 'platforms'> & { platforms?: string[] },
): ArenaEligibleRow[] {
  const minTrades = criteria.minTradesCount ?? ARENA_POOL_DEFAULTS.minTradesCount
  const minAbsDd = criteria.minAbsDrawdown ?? ARENA_POOL_DEFAULTS.minAbsDrawdown
  const minTs = criteria.minUpdatedAt.getTime()
  const platforms = criteria.platforms && criteria.platforms.length > 0
    ? new Set(criteria.platforms)
    : null

  const kept = rows.filter((r) => {
    if (platforms && !platforms.has(r.platform)) return false
    const t = Date.parse(r.updated_at)
    if (!Number.isFinite(t) || t < minTs) return false
    if (r.trades_count == null || r.trades_count < minTrades) return false
    if (r.max_drawdown == null) return false
    if (Math.abs(r.max_drawdown) < minAbsDd) return false
    return true
  })

  return dedupeLatestPerTrader(kept)
}

function dedupeLatestPerTrader(rows: readonly ArenaEligibleRow[]): ArenaEligibleRow[] {
  const latest = new Map<string, ArenaEligibleRow>()
  for (const r of rows) {
    const k = `${r.platform}\x00${r.trader_key}`
    const prev = latest.get(k)
    if (!prev) {
      latest.set(k, r)
      continue
    }
    if (Date.parse(r.updated_at) > Date.parse(prev.updated_at)) {
      latest.set(k, r)
    }
  }
  return Array.from(latest.values())
}

/**
 * Shadow-comparison artifact for the arena eligible-pool redefinition
 * (CRYAA-2118 / CRYAA-2117). CEO merge gate.
 *
 * For each window in {7D, 30D, 90D}:
 *   - Reads the current `trader_snapshots_v2` rows.
 *   - Applies the OLD predicate: top 5000 by roi_pct desc with non-null
 *     max_drawdown (the prefilter we are deleting).
 *   - Applies the NEW predicate: active in 24h + trades_count >= 30 +
 *     max_drawdown not null AND |max_drawdown| >= 0.5.
 *   - Recomputes sharpe_vs_btc per row using `aggregateExcessSharpe`.
 *   - Runs `estimatePopulation` + `shrinkOne` + `posteriorProbAbove` on
 *     each pool to produce per-trader p_superforecaster (relative to the
 *     pool's own threshold).
 *   - Counts traders with |Δp_sf| > 0.05 between the two pools (only
 *     traders present in BOTH pools, since a trader missing from one pool
 *     has no comparable p_sf).
 *
 * Usage:
 *   npx tsx scripts/shadow-eligible-pool.ts
 *
 * Reads `.env.local` for SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
 */

/* eslint-disable no-console */
import 'dotenv/config'
import { config as dotenvConfig } from 'dotenv'
import { resolve as pathResolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { aggregateExcessSharpe } from '@/lib/utils/benchmark-sharpe'
import { getBtcBenchmark } from '@/lib/data/btc-returns'
import {
  estimatePopulation,
  shrinkOne,
  posteriorProbAbove,
  thresholdForTopFraction,
} from '@/lib/utils/shrinkage'

dotenvConfig({ path: pathResolve(process.cwd(), '.env.local') })

type Window = '7D' | '30D' | '90D'
const WINDOWS: Window[] = ['7D', '30D', '90D']
const PERIOD_DAYS: Record<Window, number> = { '7D': 7, '30D': 30, '90D': 90 }
const SF_FRACTION = 0.05

interface Row {
  platform: string
  trader_key: string
  roi_pct: number | null
  max_drawdown: number | null
  trades_count: number | null
  sharpe_ratio: number | null
  updated_at: string
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function dedupeLatest(rows: Row[]): Row[] {
  const m = new Map<string, Row>()
  for (const r of rows) {
    const k = `${r.platform}\x00${r.trader_key}`
    const prev = m.get(k)
    if (!prev || Date.parse(r.updated_at) > Date.parse(prev.updated_at)) m.set(k, r)
  }
  return Array.from(m.values())
}

function applyOldPredicate(rows: Row[]): Row[] {
  // top 5000 by roi_pct desc with non-null max_drawdown
  const filtered = rows.filter((r) => r.max_drawdown != null && r.roi_pct != null)
  filtered.sort((a, b) => (b.roi_pct ?? -Infinity) - (a.roi_pct ?? -Infinity))
  return dedupeLatest(filtered.slice(0, 5000))
}

function applyNewPredicate(rows: Row[], activeSince: Date): Row[] {
  const minTs = activeSince.getTime()
  const filtered = rows.filter((r) => {
    if (r.trades_count == null || r.trades_count < 30) return false
    if (r.max_drawdown == null || Math.abs(r.max_drawdown) < 0.5) return false
    const t = Date.parse(r.updated_at)
    if (!Number.isFinite(t) || t < minTs) return false
    return true
  })
  return dedupeLatest(filtered)
}

interface PoolResult {
  eligible_n: number
  mu_pop: number | null
  tau_sq: number | null
  sf_threshold: number | null
  // p_sf by `(platform, trader_key)` for traders in this pool
  pSf: Map<string, number>
}

async function runPool(pool: Row[], window: Window): Promise<PoolResult> {
  let btcReturn = 0
  try {
    const snap = await getBtcBenchmark(window)
    btcReturn = snap.periodReturnPct
  } catch {
    /* fall through with 0 */
  }

  const enriched = pool
    .map((r) => {
      const roi = num(r.roi_pct)
      const dd = num(r.max_drawdown)
      const svb = roi != null ? aggregateExcessSharpe(roi, btcReturn, dd, PERIOD_DAYS[window]) : null
      if (svb == null) return null
      return { row: r, svb, tc: num(r.trades_count) }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  const pop = estimatePopulation(enriched.map((e) => ({ observed: e.svb, tradesCount: e.tc })))
  if (!pop) {
    return { eligible_n: enriched.length, mu_pop: null, tau_sq: null, sf_threshold: null, pSf: new Map() }
  }

  const partials = enriched.map((e) => ({
    row: e.row,
    result: shrinkOne({ observed: e.svb, tradesCount: e.tc }, pop),
  }))
  const sfThreshold = thresholdForTopFraction(
    partials.map((p) => p.result.shrunk),
    SF_FRACTION,
  )
  const pSf = new Map<string, number>()
  for (const { row, result } of partials) {
    pSf.set(
      `${row.platform}\x00${row.trader_key}`,
      posteriorProbAbove(result.shrunk, result.posteriorSd, sfThreshold),
    )
  }
  return {
    eligible_n: pop.n,
    mu_pop: pop.muPop,
    tau_sq: pop.tauSq,
    sf_threshold: sfThreshold,
    pSf,
  }
}

async function fetchWindow(client: ReturnType<typeof createClient>, window: Window): Promise<Row[]> {
  // Pull a wide raw set; the predicates filter from this.
  const { data, error } = await client
    .from('trader_snapshots_v2')
    .select('platform, trader_key, roi_pct, max_drawdown, trades_count, sharpe_ratio, updated_at')
    .eq('window', window)
    .order('updated_at', { ascending: false })
    .limit(200000)
  if (error) throw new Error(`fetch ${window} failed: ${error.message}`)
  return ((data ?? []) as unknown) as Row[]
}

function round(n: number | null, d = 4): string {
  if (n == null) return 'null'
  const m = 10 ** d
  return (Math.round(n * m) / m).toString()
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
    process.exit(2)
  }
  const client = createClient(url, key)
  const useFreshestMinus24h = process.env.SHADOW_USE_FRESHEST === '1'

  console.log(`# Shadow comparison — eligible-pool redefinition (CRYAA-2118)`)
  console.log(`# Ran at: ${new Date().toISOString()}`)
  if (useFreshestMinus24h) {
    console.log(`# Active-since: per-window (freshest updated_at − 24h)`)
  } else {
    console.log(`# Active-since: NOW() − 24h (production semantic)`)
  }
  console.log()
  console.log(
    '| window | eligible_n_old | eligible_n_new | μ_pop_old | μ_pop_new | τ²_old | τ²_new | overlap | |Δp_sf|>0.05 | new<800? |',
  )
  console.log(
    '|--------|---------------:|---------------:|----------:|----------:|-------:|-------:|--------:|------------:|:--------:|',
  )

  for (const w of WINDOWS) {
    const rows = await fetchWindow(client, w)
    const dedupedAll = dedupeLatest(rows)

    // Active-since: production semantic is NOW()−24h. For dev/replay envs
    // where ingestion may be paused, allow SHADOW_USE_FRESHEST=1 to pivot
    // off the freshest updated_at observed for this window so the new
    // predicate still produces a meaningful pool for the artifact.
    let activeSince = new Date(Date.now() - 24 * 3600 * 1000)
    if (useFreshestMinus24h) {
      const maxTs = rows.reduce(
        (max, r) => Math.max(max, Date.parse(r.updated_at) || 0),
        0,
      )
      if (maxTs > 0) activeSince = new Date(maxTs - 24 * 3600 * 1000)
    }

    const oldPool = applyOldPredicate(rows)
    const newPool = applyNewPredicate(rows, activeSince)

    const oldRes = await runPool(oldPool, w)
    const newRes = await runPool(newPool, w)

    let bigDelta = 0
    let overlap = 0
    for (const [k, vOld] of oldRes.pSf.entries()) {
      const vNew = newRes.pSf.get(k)
      if (vNew == null) continue
      overlap++
      if (Math.abs(vOld - vNew) > 0.05) bigDelta++
    }

    const flag = newRes.eligible_n < 800 ? '⚠' : ''
    console.log(
      `| ${w} | ${oldRes.eligible_n} | ${newRes.eligible_n} | ${round(oldRes.mu_pop)} | ${round(newRes.mu_pop)} | ${round(oldRes.tau_sq)} | ${round(newRes.tau_sq)} | ${overlap} | ${bigDelta} | ${flag} |`,
    )

    // Sanity reporting
    console.error(
      `[${w}] raw=${rows.length} deduped=${dedupedAll.length} old=${oldPool.length} new=${newPool.length} activeSince=${activeSince.toISOString()}`,
    )
  }
}

main().catch((err) => {
  console.error('shadow comparison failed:', err)
  process.exit(1)
})

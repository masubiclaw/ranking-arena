/**
 * Bot-facing endpoint: top N traders by a chosen criterion.
 *
 *   GET /api/top-traders?criterion=arena_score|roi|pnl|sharpe|sharpe_vs_btc
 *     &window=7D|30D|90D
 *     &limit=N        (default 50, max 500)
 *     &platform=hyperliquid,gmx  (optional, comma-separated)
 *
 * Returns a stable, minimal JSON shape designed for downstream bots:
 *
 *   {
 *     "criterion": "sharpe_vs_btc",
 *     "window": "7D",
 *     "computed_at": "...",
 *     "benchmark": { "asset": "BTC", "period_return_pct": -3.2 },  // omitted if criterion not sharpe_vs_btc
 *     "traders": [
 *       { "rank": 1, "platform": "hyperliquid", "trader_key": "0x...", "handle": "...",
 *         "roi_pct": 215.4, "pnl_usd": 424124.8, "max_drawdown_pct": 12.3,
 *         "arena_score": 99.81, "sharpe_ratio": 4.2, "sharpe_vs_btc": 6.1,
 *         "score": 6.1 }
 *     ]
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { getBtcBenchmark, type BenchmarkPeriod } from '@/lib/data/btc-returns'
import { aggregateExcessSharpe } from '@/lib/utils/benchmark-sharpe'
import {
  estimatePopulation,
  shrinkOne,
  posteriorProbAbove,
  thresholdForTopFraction,
  type ShrinkageInput,
  type ShrinkageOutput,
} from '@/lib/utils/shrinkage'

export const dynamic = 'force-dynamic'

const VALID_WINDOWS: ReadonlySet<BenchmarkPeriod> = new Set(['7D', '30D', '90D'])
const PERIOD_DAYS: Record<BenchmarkPeriod, number> = { '7D': 7, '30D': 30, '90D': 90 }
const VALID_CRITERIA = [
  'arena_score',
  'roi',
  'pnl',
  'sharpe',
  'sharpe_vs_btc',
  'shrunk_sharpe_vs_btc',
  'p_superforecaster',
] as const
type Criterion = (typeof VALID_CRITERIA)[number]

type SnapshotRow = {
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

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.BOT_API_KEY
  // No key configured = open access (dev/local). Set BOT_API_KEY in prod to lock down.
  if (!expected) return true
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header
  return timingSafeEq(presented, expected)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const criterion = (params.get('criterion') ?? 'arena_score') as Criterion
  const windowParam = (params.get('window') ?? '7D').toUpperCase() as BenchmarkPeriod
  const limit = Math.min(Math.max(parseInt(params.get('limit') ?? '50', 10) || 50, 1), 500)
  const platformFilter = params.get('platform')?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  // Drop snapshots older than this. Default 24h since the refresh cron runs at most hourly.
  const maxAgeHours = Math.min(Math.max(parseFloat(params.get('max_age_hours') ?? '24'), 1), 24 * 30)
  const minUpdatedAt = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString()

  if (!VALID_CRITERIA.includes(criterion)) {
    return NextResponse.json(
      { error: `Invalid criterion. Use one of: ${VALID_CRITERIA.join(', ')}` },
      { status: 400 },
    )
  }
  if (!VALID_WINDOWS.has(windowParam)) {
    return NextResponse.json({ error: 'Invalid window. Use 7D, 30D, or 90D.' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  const needsShrinkage = criterion === 'shrunk_sharpe_vs_btc' || criterion === 'p_superforecaster'
  const needsAllDrawdown =
    needsShrinkage || criterion === 'sharpe_vs_btc'
  // Shrinkage needs the whole BTC-eligible population, not just the top of a column.
  const poolLimit = needsAllDrawdown ? 5000 : criterion === 'sharpe' ? 2000 : limit * 4

  let query = supabase
    .from('trader_snapshots_v2')
    .select(
      'platform, trader_key, roi_pct, pnl_usd, max_drawdown, trades_count, arena_score, sharpe_ratio, updated_at',
    )
    .eq('window', windowParam)
    .gte('updated_at', minUpdatedAt)
    .limit(poolLimit)

  if (platformFilter.length > 0) {
    query = query.in('platform', platformFilter)
  }

  // For drawdown-dependent criteria, scope to rows that *have* drawdown so we
  // don't waste the pool budget on ineligible traders.
  if (needsAllDrawdown) {
    query = query.not('max_drawdown', 'is', null).order('roi_pct', { ascending: false, nullsFirst: false })
  } else {
    switch (criterion) {
      case 'roi':
        query = query.order('roi_pct', { ascending: false, nullsFirst: false })
        break
      case 'pnl':
        query = query.order('pnl_usd', { ascending: false, nullsFirst: false })
        break
      case 'sharpe':
        query = query.order('sharpe_ratio', { ascending: false, nullsFirst: false })
        break
      default:
        query = query.order('arena_score', { ascending: false, nullsFirst: false })
    }
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const rows = (data ?? []) as SnapshotRow[]

  // BTC benchmark is required for any sharpe-vs-btc variant.
  const needsBtc =
    criterion === 'sharpe_vs_btc' ||
    criterion === 'shrunk_sharpe_vs_btc' ||
    criterion === 'p_superforecaster'

  let benchmark: { asset: 'BTC'; period_return_pct: number } | undefined
  let btcPeriodReturn = 0
  if (needsBtc) {
    try {
      const snap = await getBtcBenchmark(windowParam)
      btcPeriodReturn = snap.periodReturnPct
      benchmark = { asset: 'BTC', period_return_pct: Math.round(btcPeriodReturn * 100) / 100 }
    } catch (e) {
      return NextResponse.json(
        { error: `Failed to fetch BTC benchmark: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      )
    }
  }

  // ── Shrinkage branch ──────────────────────────────────────────────────────
  // Build the population, fit μ_pop / τ², then per-trader posterior.
  let shrinkageMap: Map<string, ShrinkageOutput> | null = null
  let popParams: ReturnType<typeof estimatePopulation> | null = null
  let sfThreshold = 0
  const sfFraction = Math.min(Math.max(parseFloat(params.get('sf_fraction') ?? '0.05'), 0.001), 0.5)
  if (needsShrinkage) {
    const eligible = rows
      .map((r) => {
        const svb = r.roi_pct != null
          ? aggregateExcessSharpe(r.roi_pct, btcPeriodReturn, r.max_drawdown, PERIOD_DAYS[windowParam])
          : null
        return svb != null ? { row: r, observed: svb } : null
      })
      .filter((x): x is { row: SnapshotRow; observed: number } => x != null)

    const popInput: ShrinkageInput[] = eligible.map((e) => ({
      observed: e.observed,
      tradesCount: e.row.trades_count,
    }))
    popParams = estimatePopulation(popInput)
    if (!popParams) {
      return NextResponse.json(
        { error: 'Insufficient eligible traders for shrinkage (need ≥5 with drawdown data).' },
        { status: 422 },
      )
    }
    shrinkageMap = new Map()
    const shrunks: number[] = []
    for (const e of eligible) {
      const out = shrinkOne({ observed: e.observed, tradesCount: e.row.trades_count }, popParams)
      shrinkageMap.set(`${e.row.platform}:${e.row.trader_key}`, out)
      shrunks.push(out.shrunk)
    }
    sfThreshold = thresholdForTopFraction(shrunks, sfFraction)
  }

  const scored = rows
    .map((r) => {
      let score: number | null = null
      let sharpeVsBtc: number | null = null
      let shrunkSharpeVsBtc: number | null = null
      let posteriorSd: number | null = null
      let weightToPrior: number | null = null
      let pSf: number | null = null

      if (needsBtc && r.roi_pct != null) {
        sharpeVsBtc = aggregateExcessSharpe(
          r.roi_pct,
          btcPeriodReturn,
          r.max_drawdown,
          PERIOD_DAYS[windowParam],
        )
      }
      if (shrinkageMap) {
        const out = shrinkageMap.get(`${r.platform}:${r.trader_key}`)
        if (out) {
          shrunkSharpeVsBtc = out.shrunk
          posteriorSd = out.posteriorSd
          weightToPrior = out.weightToPrior
          pSf = posteriorProbAbove(out.shrunk, out.posteriorSd, sfThreshold)
        }
      }

      switch (criterion) {
        case 'roi':            score = r.roi_pct; break
        case 'pnl':            score = r.pnl_usd; break
        case 'sharpe':         score = r.sharpe_ratio; break
        case 'sharpe_vs_btc':  score = sharpeVsBtc; break
        case 'shrunk_sharpe_vs_btc': score = shrunkSharpeVsBtc; break
        case 'p_superforecaster':    score = pSf; break
        case 'arena_score':
        default:               score = r.arena_score
      }
      return {
        row: r,
        score,
        sharpeVsBtc,
        shrunkSharpeVsBtc,
        posteriorSd,
        weightToPrior,
        pSf,
      }
    })
    .filter((x) => x.score != null)
    .sort((a, b) => (b.score! - a.score!))
    .slice(0, limit)
    .map((x, i) => ({
      rank: i + 1,
      platform: x.row.platform,
      trader_key: x.row.trader_key,
      roi_pct: x.row.roi_pct,
      pnl_usd: x.row.pnl_usd,
      max_drawdown_pct: x.row.max_drawdown,
      trades_count: x.row.trades_count,
      arena_score: x.row.arena_score,
      sharpe_ratio: x.row.sharpe_ratio,
      sharpe_vs_btc: x.sharpeVsBtc,
      shrunk_sharpe_vs_btc: x.shrunkSharpeVsBtc,
      posterior_sd: x.posteriorSd,
      weight_to_prior: x.weightToPrior,
      p_superforecaster: x.pSf,
      score: x.score,
      updated_at: x.row.updated_at,
    }))

  const latestSnapshot = scored.reduce<string | null>(
    (acc, t) => (acc == null || t.updated_at > acc ? t.updated_at : acc),
    null,
  )
  const dataAgeSec = latestSnapshot
    ? Math.max(0, Math.round((Date.now() - new Date(latestSnapshot).getTime()) / 1000))
    : null

  const shrinkageMeta = popParams
    ? {
        mu_pop: Math.round(popParams.muPop * 1000) / 1000,
        tau_sq: Math.round(popParams.tauSq * 1000) / 1000,
        mean_sigma_sq: Math.round(popParams.meanSigmaSq * 1000) / 1000,
        eligible_population: popParams.n,
        superforecaster_threshold: Math.round(sfThreshold * 1000) / 1000,
        superforecaster_target_fraction: sfFraction,
      }
    : undefined

  return NextResponse.json(
    {
      criterion,
      window: windowParam,
      computed_at: new Date().toISOString(),
      data_freshness: {
        latest_snapshot_at: latestSnapshot,
        age_seconds: dataAgeSec,
      },
      benchmark,
      shrinkage: shrinkageMeta,
      count: scored.length,
      traders: scored,
    },
    { headers: { 'cache-control': 'public, max-age=30, s-maxage=60' } },
  )
}

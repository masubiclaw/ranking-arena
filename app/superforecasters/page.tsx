import { SuperforecasterTable } from './SuperforecasterTable'
import { getSupabaseAdmin } from '@/lib/api'
import { getBtcBenchmark } from '@/lib/data/btc-returns'
import { aggregateExcessSharpe } from '@/lib/utils/benchmark-sharpe'
import {
  estimatePopulation,
  shrinkOne,
  posteriorProbAbove,
  thresholdForTopFraction,
} from '@/lib/utils/shrinkage'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Superforecasters — Arena',
  description: 'Bayesian-shrinkage ranking of traders by Sharpe-vs-BTC.',
}

type Window = '7D' | '30D' | '90D'
const PERIOD_DAYS: Record<Window, number> = { '7D': 7, '30D': 30, '90D': 90 }
const TOP_N = 50

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchWindow(windowParam: Window) {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('trader_snapshots_v2')
    .select(
      'platform, trader_key, roi_pct, pnl_usd, max_drawdown, trades_count, arena_score, sharpe_ratio, updated_at',
    )
    .eq('window', windowParam)
    .gte('updated_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .not('max_drawdown', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(10000)

  const rawRows = data ?? []

  // Dedupe to latest snapshot per (platform, trader_key). The partition table
  // can hold multiple rows for the same trader from earlier refresh cycles.
  const latestByKey = new Map<string, typeof rawRows[number]>()
  for (const r of rawRows) {
    const k = `${r.platform}:${r.trader_key}`
    if (!latestByKey.has(k)) latestByKey.set(k, r)
  }
  const rows = Array.from(latestByKey.values())

  let btcReturn = 0
  try {
    const snap = await getBtcBenchmark(windowParam)
    btcReturn = snap.periodReturnPct
  } catch {
    /* fall through with 0 */
  }

  // Per-row sharpe vs BTC (drops anything still missing roi/dd).
  const enriched = rows
    .map((r) => {
      const roi = num(r.roi_pct)
      const dd = num(r.max_drawdown)
      const svb = roi != null ? aggregateExcessSharpe(roi, btcReturn, dd, PERIOD_DAYS[windowParam]) : null
      if (svb == null) return null
      return {
        row: r,
        roi,
        dd,
        sharpe_vs_btc: svb,
        trades_count: num(r.trades_count),
      }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  const popParams = estimatePopulation(
    enriched.map((e) => ({ observed: e.sharpe_vs_btc, tradesCount: e.trades_count })),
  )

  const allEnriched = enriched.map((e) => {
    if (!popParams) {
      return {
        platform: e.row.platform,
        trader_key: e.row.trader_key,
        roi_pct: e.roi,
        pnl_usd: num(e.row.pnl_usd),
        max_drawdown: e.dd,
        trades_count: e.trades_count,
        arena_score: num(e.row.arena_score),
        sharpe_ratio: num(e.row.sharpe_ratio),
        sharpe_vs_btc: e.sharpe_vs_btc,
        shrunk_sharpe_vs_btc: null as number | null,
        posterior_sd: null as number | null,
        weight_to_prior: null as number | null,
        p_superforecaster: null as number | null,
        updated_at: e.row.updated_at,
      }
    }
    const out = shrinkOne({ observed: e.sharpe_vs_btc, tradesCount: e.trades_count }, popParams)
    return {
      platform: e.row.platform,
      trader_key: e.row.trader_key,
      roi_pct: e.roi,
      pnl_usd: num(e.row.pnl_usd),
      max_drawdown: e.dd,
      trades_count: e.trades_count,
      arena_score: num(e.row.arena_score),
      sharpe_ratio: num(e.row.sharpe_ratio),
      sharpe_vs_btc: e.sharpe_vs_btc,
      shrunk_sharpe_vs_btc: out.shrunk,
      posterior_sd: out.posteriorSd,
      weight_to_prior: out.weightToPrior,
      p_superforecaster: null as number | null,
      updated_at: e.row.updated_at,
    }
  })

  let sfThreshold = 0
  if (popParams) {
    const shrunks = allEnriched.map((x) => x.shrunk_sharpe_vs_btc).filter((v): v is number => v != null)
    sfThreshold = thresholdForTopFraction(shrunks, 0.05)
    for (const t of allEnriched) {
      if (t.shrunk_sharpe_vs_btc != null && t.posterior_sd != null) {
        t.p_superforecaster = posteriorProbAbove(t.shrunk_sharpe_vs_btc, t.posterior_sd, sfThreshold)
      }
    }
  }

  // Distribution snapshots from the FULL eligible population
  // (before slicing to top-50) so the histograms reflect the real population.
  const dist = {
    shrunk: allEnriched.map((x) => x.shrunk_sharpe_vs_btc).filter((v): v is number => v != null),
    pSf: allEnriched.map((x) => x.p_superforecaster).filter((v): v is number => v != null),
    raw: allEnriched.map((x) => x.sharpe_vs_btc).filter((v): v is number => v != null),
  }

  allEnriched.sort(
    (a, b) => (b.shrunk_sharpe_vs_btc ?? -Infinity) - (a.shrunk_sharpe_vs_btc ?? -Infinity),
  )
  const top = allEnriched.slice(0, TOP_N)

  return {
    traders: top,
    shrinkage: popParams
      ? {
          mu_pop: round3(popParams.muPop),
          tau_sq: round3(popParams.tauSq),
          eligible_population: popParams.n,
          superforecaster_threshold: round3(sfThreshold),
          superforecaster_target_fraction: 0.05,
        }
      : null,
    benchmark: { asset: 'BTC' as const, period_return_pct: round2(btcReturn) },
    window: windowParam,
    distribution: dist,
  }
}

function round2(x: number) {
  return Math.round(x * 100) / 100
}
function round3(x: number) {
  return Math.round(x * 1000) / 1000
}

export default async function SuperforecastersPage({
  searchParams,
}: {
  searchParams?: Promise<{ window?: string }>
}) {
  const sp = (await searchParams) ?? {}
  const rawWindow = (sp.window ?? '90D').toUpperCase()
  const windowParam: Window = (['7D', '30D', '90D'] as const).includes(rawWindow as Window)
    ? (rawWindow as Window)
    : '90D'

  const result = await fetchWindow(windowParam)

  return (
    <main style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto', color: '#e8e8e8' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0 }}>Superforecasters</h1>
        <p style={{ color: '#9aa', marginTop: 8, maxWidth: 760 }}>
          Empirical-Bayes shrinkage applied to <em>Sharpe-vs-BTC</em>. Traders
          with little evidence are pulled toward the population mean; traders
          with many trades retain their observed score. The <strong>P(SF)</strong>{' '}
          column is the posterior probability that a trader sits in the top 5%
          of the population — the data-driven analogue of Tetlock's
          superforecaster bar.
        </p>
      </header>
      <SuperforecasterTable initialWindow={windowParam} initialData={result} />
    </main>
  )
}

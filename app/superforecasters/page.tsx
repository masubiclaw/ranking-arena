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
    .order('roi_pct', { ascending: false, nullsFirst: false })
    .limit(5000)

  const rows = data ?? []

  let btcReturn = 0
  try {
    const snap = await getBtcBenchmark(windowParam)
    btcReturn = snap.periodReturnPct
  } catch {
    /* fall through with btcReturn = 0 */
  }

  // Compute raw sharpe-vs-btc per row
  const enriched = rows
    .map((r) => {
      const svb =
        r.roi_pct != null
          ? aggregateExcessSharpe(
              r.roi_pct as number,
              btcReturn,
              r.max_drawdown as number | null,
              PERIOD_DAYS[windowParam],
            )
          : null
      return svb != null ? { row: r, sharpe_vs_btc: svb } : null
    })
    .filter((x): x is { row: typeof rows[number]; sharpe_vs_btc: number } => x != null)

  const popInput = enriched.map((e) => ({
    observed: e.sharpe_vs_btc,
    tradesCount: e.row.trades_count as number | null,
  }))
  const popParams = estimatePopulation(popInput)

  let shrunks: number[] = []
  let sfThreshold = 0
  const enrichedWithShrink = enriched.map((e) => {
    if (!popParams) {
      return {
        ...e.row,
        sharpe_vs_btc: e.sharpe_vs_btc,
        shrunk_sharpe_vs_btc: null,
        posterior_sd: null,
        weight_to_prior: null,
        p_superforecaster: null,
      }
    }
    const out = shrinkOne(
      { observed: e.sharpe_vs_btc, tradesCount: e.row.trades_count as number | null },
      popParams,
    )
    shrunks.push(out.shrunk)
    return {
      ...e.row,
      sharpe_vs_btc: e.sharpe_vs_btc,
      shrunk_sharpe_vs_btc: out.shrunk,
      posterior_sd: out.posteriorSd,
      weight_to_prior: out.weightToPrior,
      p_superforecaster: null as number | null,
    }
  })
  if (popParams && shrunks.length > 0) {
    sfThreshold = thresholdForTopFraction(shrunks, 0.05)
    for (const t of enrichedWithShrink) {
      if (t.shrunk_sharpe_vs_btc != null && t.posterior_sd != null) {
        t.p_superforecaster = posteriorProbAbove(
          t.shrunk_sharpe_vs_btc,
          t.posterior_sd,
          sfThreshold,
        )
      }
    }
  }

  enrichedWithShrink.sort(
    (a, b) => (b.shrunk_sharpe_vs_btc ?? -Infinity) - (a.shrunk_sharpe_vs_btc ?? -Infinity),
  )
  // Cap to 200 rows for the page
  const top = enrichedWithShrink.slice(0, 200)

  return {
    traders: top,
    shrinkage: popParams
      ? {
          mu_pop: Math.round(popParams.muPop * 1000) / 1000,
          tau_sq: Math.round(popParams.tauSq * 1000) / 1000,
          eligible_population: popParams.n,
          superforecaster_threshold: Math.round(sfThreshold * 1000) / 1000,
          superforecaster_target_fraction: 0.05,
        }
      : null,
    benchmark: { asset: 'BTC' as const, period_return_pct: Math.round(btcReturn * 100) / 100 },
    window: windowParam,
  }
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
          of the population — i.e. the data-driven analogue of Tetlock's
          superforecaster bar.
        </p>
      </header>
      <SuperforecasterTable
        initialWindow={windowParam}
        initialData={result}
      />
    </main>
  )
}

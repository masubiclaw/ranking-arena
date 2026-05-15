/**
 * BTC daily-return benchmark used as the risk-free rate for Sharpe-vs-BTC.
 *
 * We hit CoinGecko's free /market_chart endpoint, cache the result for an
 * hour, and expose helpers for both the aggregate period return (used by the
 * fallback formula) and the daily-return array (used by the full Sharpe
 * computation when a trader's equity curve is available).
 */

type BtcSnapshot = {
  dailyReturnsPct: number[]
  periodReturnPct: number
  fetchedAt: number
}

const CACHE_MS = 60 * 60 * 1000
const cache = new Map<number, BtcSnapshot>()

export type BenchmarkPeriod = '7D' | '30D' | '90D'

const PERIOD_DAYS: Record<BenchmarkPeriod, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

export async function getBtcBenchmark(period: BenchmarkPeriod): Promise<BtcSnapshot> {
  const days = PERIOD_DAYS[period]
  const cached = cache.get(days)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached

  // CoinGecko returns N+1 daily samples for `days=N&interval=daily`.
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`CoinGecko BTC fetch ${res.status}`)
  const json = (await res.json()) as { prices?: [number, number][] }
  const prices = (json.prices ?? []).map((p) => p[1])
  if (prices.length < 2) throw new Error('CoinGecko returned <2 BTC prices')

  const dailyReturnsPct: number[] = []
  for (let i = 1; i < prices.length; i++) {
    dailyReturnsPct.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100)
  }
  const periodReturnPct = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100

  const snap: BtcSnapshot = { dailyReturnsPct, periodReturnPct, fetchedAt: Date.now() }
  cache.set(days, snap)
  return snap
}

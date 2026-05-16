/**
 * Daily-granularity BTC and SPY price series used for chart overlays on the
 * trader detail page. Distinct from `btc-returns.ts` (which returns aggregate
 * period returns); this one keeps the full series so the chart can sample
 * matching timestamps.
 *
 * Cached in-memory for 1 hour. Single-source for both BTC (CoinGecko
 * market_chart) and SPY (Yahoo Finance chart).
 */

type Series = { timestamps: number[]; values: number[] }
type CachedSeries = Series & { fetchedAt: number }

const CACHE_MS = 60 * 60 * 1000
const cache = new Map<string, CachedSeries>()

export async function getBtcDailySeries(days: number): Promise<Series> {
  const key = `btc:${days}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return strip(cached)

  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`CoinGecko BTC ${res.status}`)
  const j = (await res.json()) as { prices?: [number, number][] }
  const prices = j.prices ?? []
  const series = {
    timestamps: prices.map((p) => p[0]),
    values: prices.map((p) => p[1]),
  }
  cache.set(key, { ...series, fetchedAt: Date.now() })
  return series
}

export async function getSpyDailySeries(days: number): Promise<Series> {
  const key = `spy:${days}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return strip(cached)

  const range = days <= 7 ? '1mo' : days <= 30 ? '3mo' : days <= 90 ? '6mo' : '1y'
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=${range}&interval=1d`
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'arena-ranking/1.0' } })
  if (!res.ok) throw new Error(`Yahoo SPY ${res.status}`)
  const j = (await res.json()) as {
    chart?: { result?: Array<{
      timestamp?: number[]
      indicators?: { adjclose?: Array<{ adjclose: (number | null)[] }> }
    }> }
  }
  const t = j.chart?.result?.[0]?.timestamp ?? []
  const c = j.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose ?? []
  const series = {
    timestamps: [] as number[],
    values: [] as number[],
  }
  for (let i = 0; i < t.length; i++) {
    if (typeof c[i] === 'number') {
      series.timestamps.push(t[i] * 1000)  // SPY ts in seconds; normalize to ms
      series.values.push(c[i] as number)
    }
  }
  cache.set(key, { ...series, fetchedAt: Date.now() })
  return series
}

function strip(c: CachedSeries): Series {
  return { timestamps: c.timestamps, values: c.values }
}

/**
 * Normalize a series to "% from value at startTs". Returns the same length
 * as the original (NaN where startTs is past the range). Used to overlay
 * benchmarks on a trader's equity curve.
 */
export function normalizeFromStart(series: Series, startTs: number): { timestamps: number[]; pct: number[] } {
  // Find first index >= startTs
  let baseIdx = series.timestamps.findIndex((t) => t >= startTs)
  if (baseIdx < 0) baseIdx = 0
  const base = series.values[baseIdx]
  const ts: number[] = []
  const pct: number[] = []
  for (let i = baseIdx; i < series.timestamps.length; i++) {
    ts.push(series.timestamps[i])
    pct.push(((series.values[i] - base) / base) * 100)
  }
  return { timestamps: ts, pct }
}

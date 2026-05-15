/**
 * S&P 500 returns used as a TradFi benchmark on trader detail pages.
 *
 * Uses Yahoo Finance's public chart endpoint for SPY (S&P 500 ETF) — no
 * auth, lightly rate-limited. Cached in-memory for 1 hour.
 */

type Snapshot = {
  dailyReturnsPct: number[]
  periodReturnPct: number
  fetchedAt: number
}

const CACHE_MS = 60 * 60 * 1000
const cache = new Map<number, Snapshot>()

const PERIOD_TO_RANGE: Record<number, string> = {
  7: '1mo',     // pull a month, slice
  30: '3mo',
  90: '6mo',
}

export async function getSp500Returns(periodDays: 7 | 30 | 90): Promise<Snapshot> {
  const cached = cache.get(periodDays)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached

  const range = PERIOD_TO_RANGE[periodDays] ?? '3mo'
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=${range}&interval=1d`
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'arena-ranking/1.0' } })
  if (!res.ok) throw new Error(`Yahoo SPY ${res.status}`)
  const json = (await res.json()) as {
    chart?: { result?: Array<{ indicators?: { adjclose?: Array<{ adjclose: (number | null)[] }> } }> }
  }
  const closes = json.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose ?? []
  const series = closes.filter((v): v is number => typeof v === 'number')
  if (series.length < 2) throw new Error('Yahoo returned <2 SPY closes')

  // SPY trades Mon-Fri, so we keep the trailing `periodDays * 5/7` business
  // days to approximate the calendar window the crypto traders ran over.
  const businessDays = Math.max(2, Math.round(periodDays * 5 / 7))
  const window = series.slice(-businessDays - 1)
  const periodReturnPct = ((window[window.length - 1] - window[0]) / window[0]) * 100

  const dailyReturnsPct: number[] = []
  for (let i = 1; i < window.length; i++) {
    dailyReturnsPct.push(((window[i] - window[i - 1]) / window[i - 1]) * 100)
  }

  const snap: Snapshot = { dailyReturnsPct, periodReturnPct, fetchedAt: Date.now() }
  cache.set(periodDays, snap)
  return snap
}

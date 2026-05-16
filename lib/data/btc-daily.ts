/**
 * Daily-granularity BTC and SPY price series used for chart overlays on the
 * trader detail page. Distinct from `btc-returns.ts` (which returns aggregate
 * period returns); this one keeps the full series so the chart can sample
 * matching timestamps.
 *
 * DB-first: reads from daily_benchmark_prices (populated by the
 * cache-benchmark-prices cron). Falls back to remote fetch on cold start or
 * if the DB rows are stale (>25 h old), then caches in memory for 1 h.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'

type Series = { timestamps: number[]; values: number[] }
type CachedSeries = Series & { fetchedAt: number }

const CACHE_MS = 60 * 60 * 1000
const STALE_HOURS = 25
const cache = new Map<string, CachedSeries>()

// ---------- DB helpers ----------

async function fetchFromDb(asset: string, days: number): Promise<Series | null> {
  try {
    const supabase = getSupabaseAdmin()
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('daily_benchmark_prices')
      .select('date, close_usd')
      .eq('asset', asset)
      .gte('date', since)
      .order('date', { ascending: true })
    if (error || !data || data.length < 2) return null
    // Reject if the most-recent row is older than STALE_HOURS
    const latest = new Date(data[data.length - 1].date).getTime()
    if (Date.now() - latest > STALE_HOURS * 60 * 60 * 1000) return null
    return {
      timestamps: data.map((r: { date: string; close_usd: number }) => new Date(r.date).getTime()),
      values: data.map((r: { date: string; close_usd: number }) => Number(r.close_usd)),
    }
  } catch {
    return null
  }
}

// ---------- Remote fetch helpers ----------

async function fetchBtcRemote(days: number): Promise<Series> {
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`CoinGecko BTC ${res.status}`)
  const j = (await res.json()) as { prices?: [number, number][] }
  const prices = j.prices ?? []
  return {
    timestamps: prices.map((p) => p[0]),
    values: prices.map((p) => p[1]),
  }
}

async function fetchSpyStooq(days: number): Promise<Series> {
  const d2 = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const d1 = new Date(Date.now() - (days + 30) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
  const url = `https://stooq.com/q/d/l/?s=spy.us&i=d&d1=${d1}&d2=${d2}`
  const res = await fetch(url, { headers: { accept: 'text/csv' } })
  if (!res.ok) throw new Error(`Stooq SPY ${res.status}`)
  const text = await res.text()
  const timestamps: number[] = []
  const values: number[] = []
  for (const line of text.split('\n').slice(1)) {
    const [date, , , , close] = line.trim().split(',')
    const c = parseFloat(close)
    if (date && !isNaN(c) && c > 0) {
      timestamps.push(new Date(date).getTime())
      values.push(c)
    }
  }
  if (timestamps.length < 2) throw new Error(`Stooq returned ${timestamps.length} SPY rows`)
  return { timestamps, values }
}

async function fetchSpyYahoo(days: number): Promise<Series> {
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
  const timestamps: number[] = []
  const values: number[] = []
  for (let i = 0; i < t.length; i++) {
    if (typeof c[i] === 'number') {
      timestamps.push(t[i] * 1000)
      values.push(c[i] as number)
    }
  }
  return { timestamps, values }
}

async function fetchSpyRemote(days: number): Promise<Series> {
  try {
    return await fetchSpyStooq(days)
  } catch (err) {
    console.warn('[btc-daily] Stooq failed, falling back to Yahoo:', err)
    return fetchSpyYahoo(days)
  }
}

// ---------- Public API ----------

export async function getBtcDailySeries(days: number): Promise<Series> {
  const key = `btc:${days}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return strip(cached)

  const db = await fetchFromDb('BTC', days)
  if (db) {
    cache.set(key, { ...db, fetchedAt: Date.now() })
    return db
  }

  const remote = await fetchBtcRemote(days)
  cache.set(key, { ...remote, fetchedAt: Date.now() })
  return remote
}

export async function getSpyDailySeries(days: number): Promise<Series> {
  const key = `spy:${days}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return strip(cached)

  const db = await fetchFromDb('SPY', days)
  if (db) {
    cache.set(key, { ...db, fetchedAt: Date.now() })
    return db
  }

  const remote = await fetchSpyRemote(days)
  cache.set(key, { ...remote, fetchedAt: Date.now() })
  return remote
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

/**
 * S&P 500 returns used as a TradFi benchmark on trader detail pages.
 *
 * DB-first: reads closing prices from daily_benchmark_prices (populated by
 * the cache-benchmark-prices cron). Falls back to Yahoo Finance on cold start
 * or stale DB data. Cached in-memory for 1 h to reduce DB round-trips.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'

type Snapshot = {
  dailyReturnsPct: number[]
  periodReturnPct: number
  fetchedAt: number
}

const CACHE_MS = 60 * 60 * 1000
const STALE_HOURS = 25
const cache = new Map<number, Snapshot>()

const PERIOD_TO_RANGE: Record<number, string> = {
  7: '1mo',
  30: '3mo',
  90: '6mo',
}

function buildSnapshot(closes: number[], periodDays: number): Snapshot {
  const businessDays = Math.max(2, Math.round(periodDays * 5 / 7))
  const window = closes.slice(-businessDays - 1)
  const periodReturnPct = ((window[window.length - 1] - window[0]) / window[0]) * 100
  const dailyReturnsPct: number[] = []
  for (let i = 1; i < window.length; i++) {
    dailyReturnsPct.push(((window[i] - window[i - 1]) / window[i - 1]) * 100)
  }
  return { dailyReturnsPct, periodReturnPct, fetchedAt: Date.now() }
}

async function fromDb(periodDays: number): Promise<Snapshot | null> {
  try {
    const supabase = getSupabaseAdmin()
    // Fetch extra rows to cover the business-day window calculation
    const lookback = periodDays + 14
    const since = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('daily_benchmark_prices')
      .select('date, close_usd')
      .eq('asset', 'SPY')
      .gte('date', since)
      .order('date', { ascending: true })
    if (error || !data || data.length < 2) return null
    const latest = new Date(data[data.length - 1].date).getTime()
    if (Date.now() - latest > STALE_HOURS * 60 * 60 * 1000) return null
    const closes = data.map((r: { date: string; close_usd: number }) => Number(r.close_usd))
    return buildSnapshot(closes, periodDays)
  } catch {
    return null
  }
}

async function fromRemote(periodDays: number): Promise<Snapshot> {
  const range = PERIOD_TO_RANGE[periodDays] ?? '3mo'
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=${range}&interval=1d`
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'arena-ranking/1.0' } })
  if (!res.ok) throw new Error(`Yahoo SPY ${res.status}`)
  const json = (await res.json()) as {
    chart?: { result?: Array<{ indicators?: { adjclose?: Array<{ adjclose: (number | null)[] }> } }> }
  }
  const closes = (json.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose ?? [])
    .filter((v): v is number => typeof v === 'number')
  if (closes.length < 2) throw new Error('Yahoo returned <2 SPY closes')
  return buildSnapshot(closes, periodDays)
}

export async function getSp500Returns(periodDays: 7 | 30 | 90): Promise<Snapshot> {
  const cached = cache.get(periodDays)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached

  const snap = (await fromDb(periodDays)) ?? (await fromRemote(periodDays))
  cache.set(periodDays, snap)
  return snap
}

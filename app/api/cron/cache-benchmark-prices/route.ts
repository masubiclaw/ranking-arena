/**
 * GET /api/cron/cache-benchmark-prices
 *
 * Fetches daily BTC close (CoinGecko) and SPY close (Yahoo Finance) for the
 * past 365 days and upserts them into the `daily_benchmark_prices` table.
 *
 * Schedule: Daily at 00:15 UTC — after market close data is available.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Row = { asset: string; date: string; close_usd: number }

async function fetchBtcRows(days: number): Promise<Row[]> {
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`CoinGecko BTC ${res.status}`)
  const j = (await res.json()) as { prices?: [number, number][] }
  return (j.prices ?? []).map(([ts, price]) => ({
    asset: 'BTC',
    date: new Date(ts).toISOString().slice(0, 10),
    close_usd: price,
  }))
}

/** Stooq CSV format: Date,Open,High,Low,Close,Volume */
async function fetchSpyRowsStooq(): Promise<Row[]> {
  const d2 = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const d1 = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
  const url = `https://stooq.com/q/d/l/?s=spy.us&i=d&d1=${d1}&d2=${d2}`
  const res = await fetch(url, { headers: { accept: 'text/csv' } })
  if (!res.ok) throw new Error(`Stooq SPY ${res.status}`)
  const text = await res.text()
  const rows: Row[] = []
  for (const line of text.split('\n').slice(1)) {
    const [date, , , , close] = line.trim().split(',')
    const c = parseFloat(close)
    if (date && !isNaN(c) && c > 0) {
      rows.push({ asset: 'SPY', date, close_usd: c })
    }
  }
  if (rows.length < 2) throw new Error(`Stooq returned ${rows.length} SPY rows`)
  return rows
}

async function fetchSpyRowsYahoo(): Promise<Row[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d`
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'arena-ranking/1.0' },
  })
  if (!res.ok) throw new Error(`Yahoo SPY ${res.status}`)
  const j = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[]
        indicators?: { adjclose?: Array<{ adjclose: (number | null)[] }> }
      }>
    }
  }
  const ts = j.chart?.result?.[0]?.timestamp ?? []
  const closes = j.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose ?? []
  const rows: Row[] = []
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i]
    if (typeof c === 'number') {
      rows.push({
        asset: 'SPY',
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close_usd: c,
      })
    }
  }
  return rows
}

async function fetchSpyRows(): Promise<Row[]> {
  try {
    return await fetchSpyRowsStooq()
  } catch (err) {
    console.warn('[cache-benchmark-prices] Stooq failed, falling back to Yahoo:', err)
    return fetchSpyRowsYahoo()
  }
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = await PipelineLogger.start('cache-benchmark-prices')
  try {
    const supabase = getSupabaseAdmin()

    const [btcRows, spyRows] = await Promise.all([fetchBtcRows(365), fetchSpyRows()])
    const rows = [...btcRows, ...spyRows]

    if (rows.length === 0) throw new Error('No benchmark rows fetched')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from('daily_benchmark_prices').upsert(rows, {
      onConflict: 'asset,date',
      ignoreDuplicates: false,
    })
    if (error) throw new Error(`Upsert failed: ${error.message}`)

    await log.success(rows.length)
    return NextResponse.json({ ok: true, upserted: rows.length })
  } catch (err) {
    await log.error(err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

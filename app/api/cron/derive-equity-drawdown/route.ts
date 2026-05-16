/**
 * GET /api/cron/derive-equity-drawdown
 *
 * Derives max_drawdown from equity/account-value history for platforms that
 * don't report it natively: Hyperliquid, dYdX, and GMX.
 *
 * Uses peak-to-trough drawdown on the account value curve (not cumulative PnL).
 * Only updates rows where max_drawdown IS NULL to avoid overwriting native data.
 * Sets quality_flags.dd_source = 'derived' on every row it touches.
 *
 * Sources:
 *   Hyperliquid – POST /info { type: 'portfolio' } → accountValueHistory (allTime)
 *   dYdX       – GET /v4/historical-pnl?address=&subaccountNumber=0&limit=90 → equity field
 *   GMX        – Subsquid subgraph accountPnlHistoryStats → accountValue per day
 *
 * Schedule: daily at 01:30 UTC (after compute-derived-metrics at 00:20)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── Equity-curve MDD derivation ────────────────────────────────────────────

/** Peak-to-trough max drawdown from a series of account values. Returns null if <3 points. */
function mddFromEquityCurve(values: number[]): number | null {
  if (values.length < 3) return null
  let peak = values[0]
  let maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  if (maxDD <= 0 || maxDD > 100) return null
  return Math.round(maxDD * 100) / 100
}

// ─── Hyperliquid ─────────────────────────────────────────────────────────────

async function deriveHyperliquidMDD(address: string): Promise<number | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: address }),
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return null
    const arr = (await res.json()) as Array<[string, { accountValueHistory?: Array<[number, string]> }]>
    if (!Array.isArray(arr)) return null
    // Use allTime window for maximum history
    const allTimeEntry = arr.find(([k]) => k === 'allTime')
    const history = allTimeEntry?.[1]?.accountValueHistory
    if (!Array.isArray(history) || history.length < 3) return null
    const values = history.map(([, v]) => Number(v)).filter((v) => v > 0)
    return mddFromEquityCurve(values)
  } catch {
    return null
  }
}

// ─── dYdX ────────────────────────────────────────────────────────────────────

function getDydxBase(): string {
  return (
    process.env.DYDX_PROXY_URL ||
    process.env.CF_WORKER_PROXY_URL ||
    'https://indexer.dydx.trade'
  )
}

async function deriveDydxMDD(address: string): Promise<number | null> {
  try {
    const base = getDydxBase()
    const isProxy = base !== 'https://indexer.dydx.trade'
    const url = isProxy
      ? `${base}/dydx/historical-pnl?address=${address}&subaccountNumber=0&limit=90`
      : `https://indexer.dydx.trade/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=90`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const data = (await res.json()) as { historicalPnl?: Array<{ equity?: string }> }
    const items = data?.historicalPnl
    if (!Array.isArray(items) || items.length < 3) return null
    const values = items
      .map((item) => Number(item.equity))
      .filter((v) => v > 0)
    return mddFromEquityCurve(values)
  } catch {
    return null
  }
}

// ─── GMX ─────────────────────────────────────────────────────────────────────

const GMX_SUBGRAPH = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'

async function deriveGmxMDD(address: string): Promise<number | null> {
  try {
    const query = `{
      accountPnlHistoryStats(
        where: { account_eq: "${address.toLowerCase()}" }
        orderBy: timestamp_ASC
        limit: 90
      ) {
        timestamp
        accountValue
      }
    }`
    const res = await fetch(GMX_SUBGRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      data?: { accountPnlHistoryStats?: Array<{ accountValue?: string }> }
    }
    const items = data?.data?.accountPnlHistoryStats
    if (!Array.isArray(items) || items.length < 3) return null
    const values = items
      .map((item) => Number(item.accountValue) / 1e30)
      .filter((v) => v > 0)
    return mddFromEquityCurve(values)
  } catch {
    return null
  }
}

// ─── Platform dispatch ────────────────────────────────────────────────────────

type PlatformKey = 'hyperliquid' | 'dydx' | 'gmx'

const DERIVERS: Record<PlatformKey, (address: string) => Promise<number | null>> = {
  hyperliquid: deriveHyperliquidMDD,
  dydx: deriveDydxMDD,
  gmx: deriveGmxMDD,
}

const PLATFORMS: PlatformKey[] = ['hyperliquid', 'dydx', 'gmx']
const CONCURRENCY = 4
const DELAY_MS = 500

async function runBatch<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
  delayMs: number,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn))
    if (i + concurrency < items.length) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('derive-equity-drawdown', { ttlSeconds: 290 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const supabase = getSupabaseAdmin()
  const startTime = Date.now()
  const plog = await PipelineLogger.start('derive-equity-drawdown')

  try {
    const platformStats: Record<string, { tried: number; derived: number }> = {}
    const allUpdates: Array<{ platform: string; trader_key: string; window: string; max_drawdown: number }> = []
    const WINDOWS = ['7D', '30D', '90D']

    for (const platform of PLATFORMS) {
      platformStats[platform] = { tried: 0, derived: 0 }
      const deriver = DERIVERS[platform]

      // Collect distinct trader_keys that are missing max_drawdown in ANY window
      const { data: rows, error } = await supabase
        .from('trader_snapshots_v2')
        .select('trader_key')
        .eq('platform', platform)
        .is('max_drawdown', null)
        .limit(500)

      if (error) {
        logger.warn(`[derive-equity-drawdown] ${platform}: query error: ${error.message}`)
        continue
      }

      const uniqueKeys = [...new Set((rows || []).map((r) => r.trader_key))]
      platformStats[platform].tried = uniqueKeys.length

      logger.info(`[derive-equity-drawdown] ${platform}: ${uniqueKeys.length} traders to derive`)

      await runBatch(
        uniqueKeys,
        async (traderKey) => {
          const mdd = await deriver(traderKey)
          if (mdd == null) return
          platformStats[platform].derived++
          for (const window of WINDOWS) {
            allUpdates.push({ platform, trader_key: traderKey, window, max_drawdown: mdd })
          }
        },
        CONCURRENCY,
        DELAY_MS,
      )
    }

    // Bulk-write derived drawdowns via dedicated RPC (only fills NULL rows)
    let totalUpdated = 0
    if (allUpdates.length > 0) {
      const RPC_BATCH = 500
      for (let i = 0; i < allUpdates.length; i += RPC_BATCH) {
        const batch = allUpdates.slice(i, i + RPC_BATCH)
        const { data: count, error: rpcErr } = await supabase.rpc(
          'bulk_update_derived_drawdown',
          { updates: batch },
        )
        if (rpcErr) {
          logger.warn(`[derive-equity-drawdown] RPC error: ${rpcErr.message}`)
        } else {
          totalUpdated += (count as number) || 0
        }
      }
    }

    const duration = Date.now() - startTime
    logger.info(
      `[derive-equity-drawdown] Updated ${totalUpdated} rows in ${duration}ms — ${JSON.stringify(platformStats)}`,
    )

    await plog.success(totalUpdated, { platformStats, duration })

    return NextResponse.json({
      success: true,
      updated: totalUpdated,
      platformStats,
      duration: `${duration}ms`,
    })
  } catch (error) {
    logger.apiError('/api/cron/derive-equity-drawdown', error, {})
    await plog.error(error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  } finally {
    await releaseLock()
  }
}

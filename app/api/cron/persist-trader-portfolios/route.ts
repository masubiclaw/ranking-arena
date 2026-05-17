/**
 * GET /api/cron/persist-trader-portfolios — CRYAA-2154
 *
 * Hourly cron that persists the current open positions of every trader in
 * the eligible pool (top-K by p_superforecaster on the 90D shrinkage window)
 * into `trader_portfolio_snapshots`. ACP's weekly forward-validation script
 * reads these rows via `/api/v1/trader-portfolios?snapshot_at=<iso>` to
 * replay cohort positions at T-N instead of relying on the live upstream.
 *
 * Behaviour:
 *   - Pulls the latest 90D shrinkage cohort, sorted by `p_superforecaster`
 *     desc, capped at `ARENA_PORTFOLIO_SNAPSHOT_TOP_K` (default 200).
 *   - Limits to platforms supported by `fetchPortfolio()` (hyperliquid, gmx,
 *     dydx).
 *   - Fetches portfolios with bounded concurrency (8); partial failures are
 *     logged but do not abort the run.
 *   - Upserts into `trader_portfolio_snapshots` (unique per platform +
 *     trader_key + UTC hour, so a re-fire within the same hour overwrites).
 *   - Prunes rows older than `ARENA_PORTFOLIO_SNAPSHOT_RETENTION_DAYS`
 *     (default 90) at the end of each run.
 *
 * Auth: standard `isAuthorized` Bearer check (`CRON_SECRET`).
 * Lock: `acquireCronLock('persist-trader-portfolios')` — fails open if Redis
 * is unavailable.
 */

import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/cron/utils'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { latestForWindow } from '@/lib/data/shrinkage-snapshots'
import { fetchPortfolio, SUPPORTED_POSITION_PLATFORMS } from '@/lib/data/positions'
import {
  insertBatch,
  pruneOlderThan,
  type SnapshotPosition,
  type TraderPortfolioSnapshot,
} from '@/lib/data/portfolio-snapshots'
import type { Position, TraderPortfolio } from '@/lib/data/positions/types'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const WINDOW = '90D' as const
const DEFAULT_TOP_K = 200
const DEFAULT_RETENTION_DAYS = 90
const FETCH_CONCURRENCY = 8

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function normalizePosition(p: Position): SnapshotPosition {
  return {
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    entry_price: Number.isFinite(p.entryPrice) ? p.entryPrice : null,
    mark_price: typeof p.markPrice === 'number' ? p.markPrice : null,
    leverage: typeof p.leverage === 'number' ? p.leverage : null,
    notional_usd: p.notionalUsd,
    unrealized_pnl_usd:
      typeof p.unrealizedPnlUsd === 'number' ? p.unrealizedPnlUsd : null,
    liq_price: typeof p.liqPrice === 'number' ? p.liqPrice : null,
  }
}

function toSnapshot(
  portfolio: TraderPortfolio,
  capturedAt: string
): TraderPortfolioSnapshot {
  return {
    platform: portfolio.platform,
    trader_key: portfolio.traderKey,
    captured_at: capturedAt,
    account_value_usd:
      typeof portfolio.accountValueUsd === 'number' ? portfolio.accountValueUsd : null,
    total_notional_usd: portfolio.totalNotionalUsd,
    positions: portfolio.positions.map(normalizePosition),
    source: portfolio.source,
  }
}

async function withConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners: Array<Promise<void>> = []
  const n = Math.min(Math.max(1, limit), items.length)
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const idx = cursor++
          if (idx >= items.length) return
          results[idx] = await worker(items[idx])
        }
      })()
    )
  }
  await Promise.all(runners)
  return results
}

interface RunStats {
  cohort_size: number
  attempted: number
  succeeded: number
  failed: number
  inserted: number
  pruned: number
  duration_ms: number
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('persist-trader-portfolios', { ttlSeconds: 600 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already_running' })
  }

  const startedAt = Date.now()
  const topK = readPositiveIntEnv('ARENA_PORTFOLIO_SNAPSHOT_TOP_K', DEFAULT_TOP_K)
  const retentionDays = readPositiveIntEnv(
    'ARENA_PORTFOLIO_SNAPSHOT_RETENTION_DAYS',
    DEFAULT_RETENTION_DAYS
  )
  const capturedAt = new Date().toISOString()

  const stats: RunStats = {
    cohort_size: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    inserted: 0,
    pruned: 0,
    duration_ms: 0,
  }

  try {
    // 1. Resolve cohort — top-K by p_superforecaster from latest 90D shrinkage.
    const cohort = await latestForWindow(WINDOW, {
      platforms: Array.from(SUPPORTED_POSITION_PLATFORMS),
    })
    const ranked = cohort
      .filter(
        (r) =>
          SUPPORTED_POSITION_PLATFORMS.has(r.platform) &&
          typeof r.p_superforecaster === 'number'
      )
      .sort((a, b) => (b.p_superforecaster ?? 0) - (a.p_superforecaster ?? 0))
      .slice(0, topK)
    stats.cohort_size = ranked.length

    if (ranked.length === 0) {
      logger.warn('[persist-trader-portfolios] cohort empty — skipping fetch')
    }

    // 2. Fetch portfolios with bounded concurrency. Partial failures logged
    //    but do not abort the run; the snapshot endpoint will simply return
    //    no_snapshot for traders we couldn't capture this hour.
    const fetched = await withConcurrency(ranked, FETCH_CONCURRENCY, async (row) => {
      stats.attempted += 1
      try {
        const portfolio = await fetchPortfolio(row.platform, row.trader_key)
        if (!portfolio) return null
        stats.succeeded += 1
        return portfolio
      } catch (err) {
        stats.failed += 1
        logger.warn(
          `[persist-trader-portfolios] fetch failed for ${row.platform}:${row.trader_key}:`,
          err instanceof Error ? err.message : String(err)
        )
        return null
      }
    })

    // 3. Persist.
    const snapshots = fetched
      .filter((p): p is TraderPortfolio => p !== null)
      .map((p) => toSnapshot(p, capturedAt))
    if (snapshots.length > 0) {
      stats.inserted = await insertBatch(snapshots)
    }

    // 4. Retention prune.
    try {
      stats.pruned = await pruneOlderThan(retentionDays)
    } catch (err) {
      logger.warn(
        '[persist-trader-portfolios] retention prune failed:',
        err instanceof Error ? err.message : String(err)
      )
    }

    stats.duration_ms = Date.now() - startedAt
    return NextResponse.json({
      status: 'ok',
      captured_at: capturedAt,
      top_k: topK,
      retention_days: retentionDays,
      ...stats,
    })
  } catch (err) {
    stats.duration_ms = Date.now() - startedAt
    logger.error(
      '[persist-trader-portfolios] run failed:',
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...stats,
      },
      { status: 500 }
    )
  } finally {
    await releaseLock()
  }
}

export const __test = {
  toSnapshot,
  normalizePosition,
  withConcurrency,
  DEFAULT_TOP_K,
  DEFAULT_RETENTION_DAYS,
  FETCH_CONCURRENCY,
}

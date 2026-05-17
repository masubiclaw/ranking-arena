/**
 * GET /api/v1/trader-portfolios — CRYAA-2154
 *
 * Batch portfolio read consumed by ACP's copy-trade bot (live) and the
 * weekly forward-validation script (snapshot replay).
 *
 * Modes:
 *   - **Live (default)**: calls `fetchPortfolio(platform, trader_key)` for
 *     each requested key with bounded concurrency. Partial-result tolerant —
 *     per-trader fetch failures surface as `ok: false, error: <code>` rather
 *     than aborting the batch.
 *   - **Snapshot (when `?snapshot_at=<iso>` is set)**: serves the closest
 *     `trader_portfolio_snapshots` row at-or-before `snapshot_at` per trader,
 *     persisted hourly by `/api/cron/persist-trader-portfolios`. Traders
 *     without a snapshot before the cutoff appear as
 *     `ok: false, error: 'no_snapshot'`.
 *
 * Query params:
 *   - `platform` (required) — one of `hyperliquid | gmx | dydx`.
 *   - `trader_keys` (required) — comma-separated, deduped, max 50 keys.
 *   - `snapshot_at` (optional ISO-8601) — switches to snapshot mode.
 *
 * Gate: shared `requireArenaAuth` + per-key token bucket (`gate`).
 */

import { NextRequest, NextResponse } from 'next/server'
import { gate } from '../_gate'
import { fetchPortfolio, SUPPORTED_POSITION_PLATFORMS } from '@/lib/data/positions'
import type { Position, TraderPortfolio } from '@/lib/data/positions/types'
import {
  findAtOrBeforeBatch,
  type SnapshotPosition,
  type TraderPortfolioSnapshot,
} from '@/lib/data/portfolio-snapshots'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_TRADER_KEYS = 50
const FETCH_CONCURRENCY = 8
const LIVE_CACHE_HEADER = 'public, max-age=0, s-maxage=15, stale-while-revalidate=60'
const SNAPSHOT_CACHE_HEADER = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600'

interface PortfolioPayload {
  platform: string
  trader_key: string
  account_value_usd: number | null
  total_notional_usd: number
  positions: SnapshotPosition[]
  last_captured_at: string | null
  fetched_at: string
  source?: string | null
}

interface BatchEntryOk {
  ok: true
  trader_key: string
  portfolio: PortfolioPayload
}

interface BatchEntryError {
  ok: false
  trader_key: string
  error: string
}

interface BatchResponse {
  platform: string
  fetched_at: string
  snapshot_at?: string
  results: Array<BatchEntryOk | BatchEntryError>
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

function fromLive(portfolio: TraderPortfolio, fetchedAt: string): PortfolioPayload {
  const positions = portfolio.positions.map(normalizePosition)
  return {
    platform: portfolio.platform,
    trader_key: portfolio.traderKey,
    account_value_usd:
      typeof portfolio.accountValueUsd === 'number' ? portfolio.accountValueUsd : null,
    total_notional_usd: portfolio.totalNotionalUsd,
    positions,
    last_captured_at: portfolio.fetchedAt,
    fetched_at: fetchedAt,
    source: portfolio.source,
  }
}

function fromSnapshot(snap: TraderPortfolioSnapshot, fetchedAt: string): PortfolioPayload {
  return {
    platform: snap.platform,
    trader_key: snap.trader_key,
    account_value_usd: snap.account_value_usd ?? null,
    total_notional_usd: snap.total_notional_usd ?? 0,
    positions: snap.positions,
    last_captured_at: snap.captured_at,
    fetched_at: fetchedAt,
    source: snap.source ?? null,
  }
}

function parseTraderKeys(raw: string | null): string[] | { error: string } {
  if (!raw) return { error: 'trader_keys is required (comma-separated, max 50)' }
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const k = part.trim()
    if (k.length > 0) seen.add(k)
  }
  if (seen.size === 0) return { error: 'trader_keys must contain at least one key' }
  if (seen.size > MAX_TRADER_KEYS) {
    return { error: `trader_keys exceeds max=${MAX_TRADER_KEYS}` }
  }
  return Array.from(seen)
}

function parseSnapshotAt(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d
}

async function withConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const n = Math.min(Math.max(1, limit), items.length)
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const idx = cursor++
        if (idx >= items.length) return
        out[idx] = await worker(items[idx])
      }
    })
  )
  return out
}

export async function GET(request: NextRequest) {
  const pass = gate(request)
  if (!pass.ok) return pass.response

  const { searchParams } = new URL(request.url)

  const platform = searchParams.get('platform') ?? ''
  if (!platform) {
    return NextResponse.json(
      { error: 'missing_platform', detail: 'platform query param is required' },
      { status: 400 }
    )
  }
  if (!SUPPORTED_POSITION_PLATFORMS.has(platform)) {
    return NextResponse.json(
      {
        error: 'unsupported_platform',
        detail: `platform must be one of ${Array.from(SUPPORTED_POSITION_PLATFORMS).join('|')} (got ${platform})`,
      },
      { status: 400 }
    )
  }

  const keys = parseTraderKeys(searchParams.get('trader_keys'))
  if (!Array.isArray(keys)) {
    return NextResponse.json({ error: 'invalid_trader_keys', detail: keys.error }, { status: 400 })
  }

  const snapshotAtRaw = searchParams.get('snapshot_at')
  const snapshotAt = parseSnapshotAt(snapshotAtRaw)
  if (snapshotAtRaw && !snapshotAt) {
    return NextResponse.json(
      { error: 'invalid_snapshot_at', detail: 'snapshot_at must be a valid ISO-8601 timestamp' },
      { status: 400 }
    )
  }

  const fetchedAt = new Date().toISOString()

  try {
    if (snapshotAt) {
      const map = await findAtOrBeforeBatch(
        keys.map((k) => ({ platform, trader_key: k })),
        snapshotAt
      )
      const results: BatchResponse['results'] = keys.map((trader_key) => {
        const row = map.get(`${platform}:${trader_key}`)
        if (!row) return { ok: false, trader_key, error: 'no_snapshot' }
        return { ok: true, trader_key, portfolio: fromSnapshot(row, fetchedAt) }
      })
      const body: BatchResponse = {
        platform,
        fetched_at: fetchedAt,
        snapshot_at: snapshotAt.toISOString(),
        results,
      }
      const response = NextResponse.json(body)
      response.headers.set('Cache-Control', SNAPSHOT_CACHE_HEADER)
      return response
    }

    // Live mode — bounded concurrency, partial-result tolerant.
    const results = await withConcurrency(keys, FETCH_CONCURRENCY, async (trader_key) => {
      try {
        const portfolio = await fetchPortfolio(platform, trader_key)
        if (!portfolio) {
          return { ok: false as const, trader_key, error: 'not_found' }
        }
        return {
          ok: true as const,
          trader_key,
          portfolio: fromLive(portfolio, fetchedAt),
        }
      } catch (err) {
        logger.warn(
          `[/api/v1/trader-portfolios] fetch failed for ${platform}:${trader_key}:`,
          err instanceof Error ? err.message : String(err)
        )
        return { ok: false as const, trader_key, error: 'fetch_failed' }
      }
    })

    const body: BatchResponse = {
      platform,
      fetched_at: fetchedAt,
      results,
    }
    const response = NextResponse.json(body)
    response.headers.set('Cache-Control', LIVE_CACHE_HEADER)
    return response
  } catch (err) {
    logger.error(
      '[/api/v1/trader-portfolios] unhandled error:',
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      { error: 'internal_error', detail: 'see server logs' },
      { status: 500 }
    )
  }
}

export const __test = {
  parseTraderKeys,
  parseSnapshotAt,
  normalizePosition,
  fromLive,
  fromSnapshot,
  withConcurrency,
  MAX_TRADER_KEYS,
  FETCH_CONCURRENCY,
}

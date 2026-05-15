/**
 * Cron: read recent position_changes and dispatch them through the executor.
 *
 *   GET /api/cron/copy-trade-tick?leader_platform=hyperliquid&since_seconds=120
 *
 * Default executor is dry-run (DryRunExecutor) — every intent is logged to
 * `dry_run_orders` but no real order is submitted. To enable a live executor
 * set EXECUTOR=hyperliquid (which is still a stub until the signer lands).
 *
 * Follower capital + risk limits come from env so they're easy to scope:
 *   FOLLOWER_CAPITAL_USD       — total bot capital (default 1000)
 *   COPY_MAX_NOTIONAL_USD      — cap per position (default 250)
 *   COPY_MAX_LEVERAGE          — cap leverage (default 3)
 *   COPY_LEADER_PLATFORM_DEFAULT — limits to leaders on this platform
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import {
  proportionalSizing,
  DryRunExecutor,
  HyperliquidExecutor,
  type TraderExecutor,
  type CopyContext,
} from '@/lib/copy-trading/executor'
import type { PositionChange } from '@/lib/data/positions/diff'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function selectExecutor(supabase: ReturnType<typeof getSupabaseAdmin>): TraderExecutor {
  const choice = (process.env.EXECUTOR ?? 'dry-run').toLowerCase()
  if (choice === 'hyperliquid') return new HyperliquidExecutor()
  return new DryRunExecutor(
    supabase as unknown as Parameters<typeof DryRunExecutor.prototype.execute>[0] extends never
      ? never
      : ConstructorParameters<typeof DryRunExecutor>[0],
    process.env.FOLLOWER_LABEL ?? 'local-bot',
  )
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const sinceSeconds = Math.min(
    Math.max(parseInt(params.get('since_seconds') ?? '120', 10), 10),
    60 * 60,
  )
  const leaderPlatform = params.get('leader_platform') ?? process.env.COPY_LEADER_PLATFORM_DEFAULT ?? null

  const ctx: CopyContext = {
    followerCapitalUsd: Number(process.env.FOLLOWER_CAPITAL_USD ?? 1000),
    maxPositionNotionalUsd: Number(process.env.COPY_MAX_NOTIONAL_USD ?? 250),
    maxLeverage: Number(process.env.COPY_MAX_LEVERAGE ?? 3),
  }

  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('position_changes')
    .select('*')
    .gte('detected_at', new Date(Date.now() - sinceSeconds * 1000).toISOString())
    .order('detected_at', { ascending: true })
    .limit(200)
  if (leaderPlatform) query = query.eq('platform', leaderPlatform)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const events = (data ?? []) as Array<{
    detected_at: string
    platform: string
    trader_key: string
    symbol: string
    change_type: PositionChange['changeType']
    prev_side: 'long' | 'short' | null
    prev_size: number | null
    prev_entry: number | null
    new_side: 'long' | 'short' | null
    new_size: number | null
    new_entry: number | null
    new_notional: number | null
    size_delta_pct: number | null
  }>

  if (events.length === 0) {
    return NextResponse.json({ ok: true, events: 0, executed: 0 })
  }

  const executor = selectExecutor(supabase)

  const intents = events.map((ev) => {
    const change: PositionChange = {
      symbol: ev.symbol,
      changeType: ev.change_type,
      prev: ev.prev_side
        ? { side: ev.prev_side, size: ev.prev_size ?? 0, entryPrice: ev.prev_entry ?? 0 }
        : null,
      next: ev.new_side
        ? {
            side: ev.new_side,
            size: ev.new_size ?? 0,
            entryPrice: ev.new_entry ?? 0,
            notionalUsd: ev.new_notional ?? 0,
          }
        : null,
      sizeDeltaPct: ev.size_delta_pct,
    }
    const order = proportionalSizing.size(change, ctx)
    return { ev, order }
  })

  const executed = []
  for (const { ev, order } of intents) {
    if (!order) {
      executed.push({ skipped: true, reason: 'no order from sizing', event: ev.symbol })
      continue
    }
    const result = await executor.execute(order)
    executed.push({ event: `${ev.symbol} ${ev.change_type}`, ...result })
  }

  return NextResponse.json({
    ok: true,
    executor: executor.name,
    leader_platform: leaderPlatform,
    follower_capital_usd: ctx.followerCapitalUsd,
    max_notional_usd: ctx.maxPositionNotionalUsd,
    max_leverage: ctx.maxLeverage,
    events: events.length,
    executed: executed.length,
    results: executed,
  })
}

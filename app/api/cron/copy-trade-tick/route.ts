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
  type TraderExecutor,
  type CopyContext,
} from '@/lib/copy-trading/executor'
import { HyperliquidLiveExecutor } from '@/lib/copy-trading/hyperliquid-executor'
import {
  applyGuards,
  loadSettingsRow,
  loadStateRow,
  type CopySettings,
  type CopyState,
} from '@/lib/copy-trading/guards'
import type { PositionChange } from '@/lib/data/positions/diff'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

function selectExecutor(supabase: ReturnType<typeof getSupabaseAdmin>): TraderExecutor {
  const choice = (process.env.EXECUTOR ?? 'dry-run').toLowerCase()
  if (choice === 'hyperliquid') return new HyperliquidLiveExecutor()
  return new DryRunExecutor(
    supabase as unknown as ConstructorParameters<typeof DryRunExecutor>[0],
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

  const followerLabel = process.env.FOLLOWER_LABEL ?? 'local-bot'
  const supabase = getSupabaseAdmin()

  // Load runtime-tunable guards from the DB. Fall back to env if missing.
  const [{ data: settingsRow }, { data: stateRow }] = await Promise.all([
    supabase.from('copy_settings').select('*').eq('follower', followerLabel).maybeSingle(),
    supabase.from('copy_state').select('*').eq('follower', followerLabel).maybeSingle(),
  ])
  const settings: CopySettings = settingsRow
    ? loadSettingsRow(settingsRow as Record<string, unknown>)
    : {
        follower: followerLabel,
        capitalUsd: Number(process.env.FOLLOWER_CAPITAL_USD ?? 1000),
        maxPositionNotionalUsd: Number(process.env.COPY_MAX_NOTIONAL_USD ?? 250),
        maxLeverage: Number(process.env.COPY_MAX_LEVERAGE ?? 3),
        maxConcurrentPositions: 5,
        symbolWhitelist: null,
        symbolBlacklist: null,
        cooldownMinutesOnLosses: 30,
        lossStreakThreshold: 3,
        maxLossPerTradePct: 5,
        enabled: true,
      }
  const state: CopyState = stateRow
    ? loadStateRow(stateRow as Record<string, unknown>)
    : { follower: followerLabel, lossStreak: 0, cooldownUntil: null, lastEventAt: null }

  const ctx: CopyContext = {
    followerCapitalUsd: settings.capitalUsd,
    maxPositionNotionalUsd: settings.maxPositionNotionalUsd,
    maxLeverage: settings.maxLeverage,
  }

  // Count current open positions for the cap guard. dry_run_orders is the
  // best proxy when we're not yet executing live.
  const { count: openCount } = await supabase
    .from('dry_run_orders')
    .select('*', { count: 'exact', head: true })
    .eq('follower', followerLabel)
    .in('intent', ['open', 'flip', 'increase'])
    .gte('submitted_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
  const openPositionCount = openCount ?? 0

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

  const executed: Array<Record<string, unknown>> = []
  let openCountRunning = openPositionCount
  let pnlLogged = 0
  let lossStreakNow = state.lossStreak
  let cooldownUntilNow: string | null = state.cooldownUntil

  // ── 1) Realized-PnL bookkeeping ─────────────────────────────────────────
  // Walk close events first so the streak/cooldown is current before any
  // new orders go out this tick. Only process events newer than what we
  // already recorded — copy_state.last_event_at is the high-water mark.
  const lastWatermark = state.lastEventAt ?? '1970-01-01T00:00:00Z'
  const closeEvents = events.filter((e) =>
    e.change_type === 'closed' &&
    e.exit_price != null &&
    e.prev_entry != null &&
    e.prev_size != null &&
    e.detected_at > lastWatermark
  )
  for (const ev of closeEvents) {
    // Leader-side directional PnL per unit (USD per leader-base-size unit)
    const dir = ev.prev_side === 'long' ? 1 : -1
    const perUnit = (Number(ev.exit_price) - Number(ev.prev_entry)) * dir
    // Scale to our follower notional: we copied `target_notional` (USD) at
    // leader's entry, so our position size in leader-base units was
    // target_notional / entry. Use the most recent matching dry_run_order.
    const { data: orderRows } = await supabase
      .from('dry_run_orders')
      .select('target_notional_usd, side')
      .eq('follower', followerLabel)
      .eq('symbol', ev.symbol)
      .eq('intent', 'open')
      .order('submitted_at', { ascending: false })
      .limit(1)
    const intentRow = orderRows?.[0]
    if (!intentRow) continue
    const followerNotional = Number(intentRow.target_notional_usd)
    const followerSize = followerNotional / Number(ev.prev_entry)
    const pnl = round2(perUnit * followerSize)

    await supabase.from('copy_realized_pnl').insert([{
      follower: followerLabel,
      leader_platform: ev.platform,
      leader_key: ev.trader_key,
      symbol: ev.symbol,
      side: ev.prev_side,
      notional_usd: followerNotional,
      entry_price: Number(ev.prev_entry),
      exit_price: Number(ev.exit_price),
      pnl_usd: pnl,
      closed_at: ev.detected_at,
    }])
    pnlLogged++

    // Streak math: increment on loss, reset on gain.
    if (pnl < 0) {
      lossStreakNow++
      if (lossStreakNow >= settings.lossStreakThreshold && settings.cooldownMinutesOnLosses > 0) {
        cooldownUntilNow = new Date(Date.now() + settings.cooldownMinutesOnLosses * 60_000).toISOString()
      }
    } else if (pnl > 0) {
      lossStreakNow = 0
      cooldownUntilNow = null
    }
  }

  // High-water mark = max detected_at across ALL events seen this tick
  // (not just closed ones) — prevents re-seeing already-processed events.
  const newWatermark = events.reduce(
    (m, e) => (e.detected_at > m ? e.detected_at : m),
    lastWatermark,
  )

  if (pnlLogged > 0 || lossStreakNow !== state.lossStreak || cooldownUntilNow !== state.cooldownUntil || newWatermark !== lastWatermark) {
    await supabase.from('copy_state').upsert({
      follower: followerLabel,
      loss_streak: lossStreakNow,
      cooldown_until: cooldownUntilNow,
      last_event_at: newWatermark,
      updated_at: new Date().toISOString(),
    })
    // refresh in-memory state so the guard below sees the new cooldown
    state.lossStreak = lossStreakNow
    state.cooldownUntil = cooldownUntilNow
  }

  // ── 2) Sizing + execution ──────────────────────────────────────────────
  for (const { ev, order } of intents) {
    if (!order) {
      executed.push({ skipped: true, reason: 'no order from sizing', event: ev.symbol })
      continue
    }
    const guard = applyGuards(order, settings, state, { openPositionCount: openCountRunning })
    if (!guard.ok || !guard.order) {
      executed.push({ skipped: true, reason: guard.reason, event: `${ev.symbol} ${ev.change_type}` })
      continue
    }
    const result = await executor.execute(guard.order)
    executed.push({ event: `${ev.symbol} ${ev.change_type}`, ...result })
    if (result.ok && (guard.order.intent === 'open' || guard.order.intent === 'flip' || guard.order.intent === 'increase')) {
      openCountRunning++
    }
  }

  return NextResponse.json({
    ok: true,
    executor: executor.name,
    follower: followerLabel,
    leader_platform: leaderPlatform,
    pnl_logged: pnlLogged,
    loss_streak: lossStreakNow,
    cooldown_until: cooldownUntilNow,
    settings: {
      capital_usd: settings.capitalUsd,
      max_notional_usd: settings.maxPositionNotionalUsd,
      max_leverage: settings.maxLeverage,
      max_concurrent_positions: settings.maxConcurrentPositions,
      whitelist: settings.symbolWhitelist,
      blacklist: settings.symbolBlacklist,
      enabled: settings.enabled,
    },
    state: {
      loss_streak: state.lossStreak,
      cooldown_until: state.cooldownUntil,
    },
    open_positions_before: openPositionCount,
    events: events.length,
    executed: executed.filter((e) => !('skipped' in e)).length,
    skipped: executed.filter((e) => 'skipped' in e).length,
    results: executed,
  })
}

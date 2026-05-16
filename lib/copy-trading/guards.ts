/**
 * Safety guards layered on top of the bare sizing strategy.
 *
 * Composition: the cron tick fetches `CopySettings`, asks the strategy for
 * an order, then runs the order through `applyGuards` which can:
 *   - veto due to whitelist/blacklist
 *   - veto due to cooldown (loss-streak)
 *   - veto due to max-concurrent-positions cap
 *   - shrink the order to obey max-loss-per-trade
 *
 * Every veto returns a `{ ok: false, reason }` decision the cron logs but
 * doesn't execute. This is intentionally simple — the *strategy* decides
 * what we want; the *guards* decide what we're allowed to do.
 */

import type { SizedOrder } from './executor'

export interface CopySettings {
  follower: string
  capitalUsd: number
  maxPositionNotionalUsd: number
  maxLeverage: number
  maxConcurrentPositions: number
  symbolWhitelist: string[] | null
  symbolBlacklist: string[] | null
  cooldownMinutesOnLosses: number
  lossStreakThreshold: number
  maxLossPerTradePct: number
  enabled: boolean
}

export interface CopyState {
  follower: string
  lossStreak: number
  cooldownUntil: string | null
  lastEventAt: string | null
}

export interface GuardDecision {
  ok: boolean
  order?: SizedOrder
  reason?: string
}

export function applyGuards(
  order: SizedOrder,
  settings: CopySettings,
  state: CopyState,
  ctx: { openPositionCount: number; now?: Date },
): GuardDecision {
  if (!settings.enabled) {
    return { ok: false, reason: 'follower disabled' }
  }

  // Cooldown after a losing streak
  if (state.cooldownUntil && new Date(state.cooldownUntil) > (ctx.now ?? new Date())) {
    return { ok: false, reason: `in cooldown until ${state.cooldownUntil} (loss streak ${state.lossStreak})` }
  }

  // Whitelist/blacklist
  if (settings.symbolWhitelist && settings.symbolWhitelist.length > 0 &&
      !settings.symbolWhitelist.includes(order.symbol)) {
    return { ok: false, reason: `${order.symbol} not in whitelist` }
  }
  if (settings.symbolBlacklist && settings.symbolBlacklist.includes(order.symbol)) {
    return { ok: false, reason: `${order.symbol} blacklisted` }
  }

  // Position cap — applies to "open"/"flip" (new exposure), not close/decrease
  const opensExposure = order.intent === 'open' || order.intent === 'flip' || order.intent === 'increase'
  if (opensExposure && ctx.openPositionCount >= settings.maxConcurrentPositions) {
    return {
      ok: false,
      reason: `at max concurrent positions (${ctx.openPositionCount}/${settings.maxConcurrentPositions})`,
    }
  }

  // Hard cap on per-position notional (defence in depth even though strategy already caps)
  let notional = order.notionalUsd
  if (notional > settings.maxPositionNotionalUsd) {
    notional = settings.maxPositionNotionalUsd
  }

  // Max loss per trade — convert pct of capital to a notional cap given leverage.
  // If we're willing to lose X% of capital on this trade and our leverage is L,
  // the position can move at most (X / L)% against us before we're stopped.
  // The notional cap that respects this is capital * X / L. (Conservative.)
  const lossCapNotional =
    (settings.capitalUsd * settings.maxLossPerTradePct) / 100 / order.leverage
  if (lossCapNotional > 0 && notional > lossCapNotional) {
    notional = lossCapNotional
  }

  if (notional <= 0 && order.intent !== 'close' && order.intent !== 'decrease') {
    return { ok: false, reason: 'notional clamped to 0 — would be a no-op' }
  }

  return {
    ok: true,
    order: { ...order, notionalUsd: round2(notional) },
  }
}

export function loadSettingsRow(row: Record<string, unknown>): CopySettings {
  return {
    follower: String(row.follower),
    capitalUsd: Number(row.capital_usd ?? 0),
    maxPositionNotionalUsd: Number(row.max_position_notional_usd ?? 0),
    maxLeverage: Number(row.max_leverage ?? 1),
    maxConcurrentPositions: Number(row.max_concurrent_positions ?? 0),
    symbolWhitelist: (row.symbol_whitelist as string[] | null) ?? null,
    symbolBlacklist: (row.symbol_blacklist as string[] | null) ?? null,
    cooldownMinutesOnLosses: Number(row.cooldown_minutes_on_losses ?? 0),
    lossStreakThreshold: Number(row.loss_streak_threshold ?? 0),
    maxLossPerTradePct: Number(row.max_loss_per_trade_pct ?? 0),
    enabled: Boolean(row.enabled ?? true),
  }
}

export function loadStateRow(row: Record<string, unknown>): CopyState {
  return {
    follower: String(row.follower),
    lossStreak: Number(row.loss_streak ?? 0),
    cooldownUntil: (row.cooldown_until as string | null) ?? null,
    lastEventAt: (row.last_event_at as string | null) ?? null,
  }
}

function round2(x: number) {
  return Math.round(x * 100) / 100
}

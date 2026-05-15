/**
 * Copy-trading executor interface + a Hyperliquid dry-run implementation.
 *
 * The executor is the layer that sits between the position-change stream
 * and an actual exchange. It receives change events, decides what to
 * mirror, sizes the copy trade according to a strategy, and submits the
 * order. The interface intentionally hides venue-specific signing/order
 * mechanics so a follower-side strategy can be ported across venues.
 *
 * Two implementations:
 *   - DryRunExecutor  — logs intents to the dry_run_orders table. No
 *                       on-chain or exchange action. Safe to run in any
 *                       environment.
 *   - HyperliquidExecutor — TODO: real order submission via HL's signing
 *                       library. Stubbed; requires API wallet + signer.
 *
 * Sizing strategy is decoupled (`SizingStrategy`) so you can swap
 * "fixed-fraction of leader notional", "scaled-by-Sharpe", "capital-cap" etc
 * without touching the executor itself.
 */

import type { PositionChange } from '@/lib/data/positions/diff'

// ── Strategy ────────────────────────────────────────────────────────────────

export interface CopyContext {
  /** Follower's available capital (USD). */
  followerCapitalUsd: number
  /** Leader's most recent estimated account value, if known. */
  leaderAccountValueUsd?: number
  /** Max notional we'll allow in a single position, USD. */
  maxPositionNotionalUsd: number
  /** Max leverage we'll apply to a follower position. */
  maxLeverage: number
}

export interface SizedOrder {
  symbol: string
  side: 'long' | 'short'
  notionalUsd: number   // size we want to be in *after* this order
  leverage: number
  intent: 'open' | 'increase' | 'decrease' | 'close' | 'flip'
}

export interface SizingStrategy {
  /** Map a leader's change event into the follower-side desired order. Return null to ignore. */
  size(change: PositionChange, ctx: CopyContext): SizedOrder | null
}

/**
 * Default: mirror the *fraction* of the leader's book that the position
 * represents, applied to the follower's capital. Caps notional and leverage.
 */
export const proportionalSizing: SizingStrategy = {
  size(change, ctx) {
    if (change.changeType === 'closed') {
      return change.prev
        ? { symbol: change.symbol, side: change.prev.side, notionalUsd: 0, leverage: 1, intent: 'close' }
        : null
    }
    const next = change.next
    if (!next) return null

    // Without leader account value we fall back to a flat 5% of capital per position.
    const leaderTotal = ctx.leaderAccountValueUsd ?? 0
    const fraction = leaderTotal > 0 ? Math.min(0.5, next.notionalUsd / leaderTotal) : 0.05
    const targetNotional = Math.min(
      ctx.maxPositionNotionalUsd,
      ctx.followerCapitalUsd * fraction * ctx.maxLeverage,
    )

    const intent: SizedOrder['intent'] =
      change.changeType === 'opened' ? 'open' :
      change.changeType === 'flipped' ? 'flip' :
      change.changeType === 'resized' && (change.sizeDeltaPct ?? 0) > 0 ? 'increase' :
      'decrease'

    return {
      symbol: change.symbol,
      side: next.side,
      notionalUsd: Math.round(targetNotional * 100) / 100,
      leverage: ctx.maxLeverage,
      intent,
    }
  },
}

// ── Executor ────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  ok: boolean
  intent: SizedOrder['intent']
  symbol: string
  side: SizedOrder['side']
  notionalUsd: number
  /** Provider order ID if accepted, otherwise diagnostic. */
  ref: string
  reason?: string
}

export interface TraderExecutor {
  /** Human-readable label, e.g. "hyperliquid-dryrun". */
  name: string
  execute(order: SizedOrder): Promise<ExecutionResult>
}

/**
 * Logs orders to a `dry_run_orders` table. Use this in dev or in prod
 * before you trust a real executor. Safe by construction.
 */
export class DryRunExecutor implements TraderExecutor {
  name = 'dry-run'
  constructor(
    private supabase: { from: (t: string) => { insert: (rows: unknown[]) => Promise<{ error: unknown }> } },
    private followerLabel: string,
  ) {}
  async execute(order: SizedOrder): Promise<ExecutionResult> {
    const row = {
      follower: this.followerLabel,
      symbol: order.symbol,
      side: order.side,
      intent: order.intent,
      target_notional_usd: order.notionalUsd,
      leverage: order.leverage,
      submitted_at: new Date().toISOString(),
    }
    const { error } = await this.supabase.from('dry_run_orders').insert([row])
    if (error) {
      return {
        ok: false,
        intent: order.intent,
        symbol: order.symbol,
        side: order.side,
        notionalUsd: order.notionalUsd,
        ref: 'dry-run',
        reason: `${error}`,
      }
    }
    return {
      ok: true,
      intent: order.intent,
      symbol: order.symbol,
      side: order.side,
      notionalUsd: order.notionalUsd,
      ref: 'dry-run',
    }
  }
}

/**
 * Stub. Real Hyperliquid execution needs an API wallet, signing
 * (EIP-712 over the action payload), and the /exchange endpoint. Returns
 * `ok: false` until those are wired.
 */
export class HyperliquidExecutor implements TraderExecutor {
  name = 'hyperliquid'
  async execute(order: SizedOrder): Promise<ExecutionResult> {
    return {
      ok: false,
      intent: order.intent,
      symbol: order.symbol,
      side: order.side,
      notionalUsd: order.notionalUsd,
      ref: 'unimplemented',
      reason:
        'HyperliquidExecutor requires an API wallet (HL_PRIVATE_KEY) and the ' +
        '@nktkas/hyperliquid signer. Pending integration.',
    }
  }
}

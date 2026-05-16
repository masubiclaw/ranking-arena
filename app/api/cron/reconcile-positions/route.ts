/**
 * Cron: detect divergence between *intent* (the bot's recorded orders) and
 * *reality* (what the follower wallet actually holds on the exchange).
 *
 *   GET /api/cron/reconcile-positions
 *   Auth: Bearer $CRON_SECRET
 *
 * Why bother:
 *   - A live order may have been rejected by the exchange (insufficient margin,
 *     symbol delisted, rate limit) — we'd think we have a position we don't.
 *   - A live order may have been *partial fill* — actual size < intended size.
 *   - The bot may have inherited stale positions from before tracking began.
 *
 * Four drift types are recorded:
 *   orphan         — we have a position the bot never intended (cleanup needed)
 *   missing        — we intended a position but it's not on the book
 *   side_mismatch  — long vs short doesn't match intent
 *   size_drift     — same side, but size differs by more than the threshold
 *
 * Reconciliation events are append-only. A separate cron (or human) decides
 * whether to act on them. We intentionally do NOT auto-close orphans by
 * default — that's a separate `?close_orphans=1` action.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { fetchPortfolio, type Position } from '@/lib/data/positions'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SIZE_DRIFT_THRESHOLD_PCT = 5  // >5% size mismatch flagged

interface IntentRow {
  symbol: string
  side: 'long' | 'short'
  notional_usd: number
  entry_price: number | null
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const followerFilter = params.get('follower')

  const supabase = getSupabaseAdmin()
  let walletQuery = supabase.from('follower_wallets').select('follower, platform, address')
  if (followerFilter) walletQuery = walletQuery.eq('follower', followerFilter)
  const { data: wallets, error } = await walletQuery
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!wallets || wallets.length === 0) {
    return NextResponse.json({ ok: true, message: 'No follower_wallets configured.' })
  }

  const allDrift: Array<Record<string, unknown>> = []
  const perFollower: Record<string, { intent: number; actual: number; drift: number }> = {}

  for (const w of wallets) {
    const { follower, platform, address } = w as { follower: string; platform: string; address: string }
    // Intent = net position assembled from dry_run_orders. We sum signed
    // notionals per symbol; the leftover is what the bot *thinks* it holds.
    const { data: intentRowsRaw } = await supabase
      .from('dry_run_orders')
      .select('symbol, side, intent, target_notional_usd')
      .eq('follower', follower)
      .order('submitted_at', { ascending: true })

    const intentMap = new Map<string, IntentRow>()
    for (const o of intentRowsRaw ?? []) {
      const sym = o.symbol as string
      const sideMult = (o.side as 'long' | 'short') === 'long' ? 1 : -1
      const intent = o.intent as string
      const usd = Number(o.target_notional_usd ?? 0)
      const signed = (intent === 'close' || intent === 'decrease') ? -sideMult * usd : sideMult * usd
      const prev = intentMap.get(sym)?.notional_usd ?? 0
      const next = prev + signed
      if (Math.abs(next) < 1) {
        intentMap.delete(sym)
      } else {
        intentMap.set(sym, {
          symbol: sym,
          side: next > 0 ? 'long' : 'short',
          notional_usd: Math.abs(next),
          entry_price: null,
        })
      }
    }

    // Actual = live exchange positions.
    const portfolio = await fetchPortfolio(platform, address)
    const actualMap = new Map<string, Position>()
    for (const p of portfolio?.positions ?? []) {
      actualMap.set(p.symbol, p)
    }

    const symbols = new Set<string>([...intentMap.keys(), ...actualMap.keys()])
    const drifts: Array<Record<string, unknown>> = []

    for (const sym of symbols) {
      const intent = intentMap.get(sym)
      const actual = actualMap.get(sym)

      if (!intent && actual) {
        drifts.push({
          follower,
          symbol: sym,
          drift_type: 'orphan',
          intent_side: null,
          intent_size: null,
          actual_side: actual.side,
          actual_size: actual.size,
          drift_pct: 100,
          note: 'position exists on exchange, no recorded intent',
        })
        continue
      }
      if (intent && !actual) {
        drifts.push({
          follower,
          symbol: sym,
          drift_type: 'missing',
          intent_side: intent.side,
          intent_size: intent.notional_usd,
          actual_side: null,
          actual_size: null,
          drift_pct: -100,
          note: 'intent recorded but no position on exchange',
        })
        continue
      }
      if (intent && actual) {
        if (intent.side !== actual.side) {
          drifts.push({
            follower,
            symbol: sym,
            drift_type: 'side_mismatch',
            intent_side: intent.side,
            intent_size: intent.notional_usd,
            actual_side: actual.side,
            actual_size: actual.size,
            drift_pct: null,
            note: 'intent and actual sides disagree',
          })
          continue
        }
        // Size drift — compare actual *notional* (notionalUsd) to intent notional.
        const intentNotional = intent.notional_usd
        const actualNotional = actual.notionalUsd
        const driftPct = intentNotional > 0
          ? ((actualNotional - intentNotional) / intentNotional) * 100
          : null
        if (driftPct != null && Math.abs(driftPct) >= SIZE_DRIFT_THRESHOLD_PCT) {
          drifts.push({
            follower,
            symbol: sym,
            drift_type: 'size_drift',
            intent_side: intent.side,
            intent_size: intentNotional,
            actual_side: actual.side,
            actual_size: actual.size,
            drift_pct: round2(driftPct),
            note: `size off by ${driftPct.toFixed(1)}%`,
          })
        }
      }
    }

    if (drifts.length > 0) {
      await supabase.from('reconciliation_events').insert(drifts)
      allDrift.push(...drifts)
    }
    perFollower[follower] = {
      intent: intentMap.size,
      actual: actualMap.size,
      drift: drifts.length,
    }
  }

  return NextResponse.json({
    ok: true,
    followers: perFollower,
    total_drifts_recorded: allDrift.length,
    drifts: allDrift,
  })
}

function round2(x: number) {
  return Math.round(x * 100) / 100
}

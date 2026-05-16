/**
 * Cron: poll tracked traders, diff against last-known positions, write
 * change events. Designed to run every 1-5 minutes for copy-trading freshness.
 *
 *   GET /api/cron/poll-positions
 *   Headers: Authorization: Bearer $CRON_SECRET
 *
 * Query params:
 *   limit     — max traders to poll this run (default 50)
 *   platform  — restrict to one platform
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { fetchPortfolio, type Position, SUPPORTED_POSITION_PLATFORMS } from '@/lib/data/positions'
import { diffPositions } from '@/lib/data/positions/diff'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const limit = Math.min(Math.max(parseInt(params.get('limit') ?? '50', 10) || 50, 1), 500)
  const platformParam = params.get('platform')

  const supabase = getSupabaseAdmin()

  // Pull tracked traders, oldest-polled first.
  let query = supabase
    .from('tracked_traders')
    .select('platform, trader_key, last_polled')
    .order('last_polled', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (platformParam) query = query.eq('platform', platformParam)

  const { data: tracked, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!tracked || tracked.length === 0) {
    return NextResponse.json({
      ok: true,
      polled: 0,
      message: 'No tracked traders. Add rows to tracked_traders to begin polling.',
    })
  }

  // Filter to platforms we can actually fetch.
  const eligible = tracked.filter((t) => SUPPORTED_POSITION_PLATFORMS.has(t.platform))

  let polled = 0
  let changesWritten = 0
  const errors: Array<{ platform: string; trader_key: string; error: string }> = []

  for (const t of eligible) {
    polled++
    try {
      const portfolio = await fetchPortfolio(t.platform, t.trader_key)
      if (!portfolio) continue

      // Load existing snapshot from trader_positions
      const { data: prevRows } = await supabase
        .from('trader_positions')
        .select('symbol, side, size, entry_price, notional_usd')
        .eq('platform', t.platform)
        .eq('trader_key', t.trader_key)

      const prevPositions: Position[] = (prevRows ?? []).map((r) => ({
        symbol: r.symbol as string,
        side: r.side as 'long' | 'short',
        size: Number(r.size),
        entryPrice: Number(r.entry_price),
        notionalUsd: Number(r.notional_usd),
      }))

      const changes = diffPositions(prevPositions, portfolio.positions)

      if (changes.length > 0) {
        // For "closed" events the next-mark is gone from the portfolio.
        // Fall back to the previous snapshot's last-seen mark price, then
        // to entry. The realized-PnL ledger will use this as the exit
        // price for both leader and follower books.
        const prevByKey = new Map(prevRows?.map((r) => [r.symbol as string, r]) ?? [])
        const rows = changes.map((c) => {
          let exitPrice: number | null = null
          if (c.changeType === 'closed') {
            // Best exit-price proxy: the last mark price we saw before close.
            // `trader_positions` row recorded notional_usd + size at the
            // previous poll, so mark ≈ notional / size. Falls back to entry
            // if that division is undefined.
            const prev = prevByKey.get(c.symbol)
            const prevSize = prev?.size != null ? Number(prev.size) : 0
            const prevNotional = prev?.notional_usd != null ? Number(prev.notional_usd) : 0
            if (prevSize > 0 && prevNotional > 0) {
              exitPrice = prevNotional / prevSize
            } else if (prev?.entry_price != null) {
              exitPrice = Number(prev.entry_price)
            }
          }
          return {
            platform: t.platform,
            trader_key: t.trader_key,
            symbol: c.symbol,
            change_type: c.changeType,
            prev_side: c.prev?.side ?? null,
            prev_size: c.prev?.size ?? null,
            prev_entry: c.prev?.entryPrice ?? null,
            new_side: c.next?.side ?? null,
            new_size: c.next?.size ?? null,
            new_entry: c.next?.entryPrice ?? null,
            new_notional: c.next?.notionalUsd ?? null,
            size_delta_pct: c.sizeDeltaPct,
            exit_price: exitPrice,
          }
        })
        const { error: insErr } = await supabase.from('position_changes').insert(rows)
        if (insErr) {
          errors.push({ platform: t.platform, trader_key: t.trader_key, error: insErr.message })
          continue
        }
        changesWritten += rows.length
      }

      // Replace trader_positions with the new snapshot. Easier than fine-grained
      // upserts and matches the "latest known state" semantics.
      await supabase
        .from('trader_positions')
        .delete()
        .eq('platform', t.platform)
        .eq('trader_key', t.trader_key)
      if (portfolio.positions.length > 0) {
        await supabase.from('trader_positions').insert(
          portfolio.positions.map((p) => ({
            platform: t.platform,
            trader_key: t.trader_key,
            symbol: p.symbol,
            side: p.side,
            size: p.size,
            entry_price: p.entryPrice,
            notional_usd: p.notionalUsd,
            leverage: p.leverage ?? null,
            unrealized_pnl_usd: p.unrealizedPnlUsd ?? null,
          })),
        )
      }

      await supabase
        .from('tracked_traders')
        .update({ last_polled: new Date().toISOString() })
        .eq('platform', t.platform)
        .eq('trader_key', t.trader_key)
    } catch (e) {
      errors.push({
        platform: t.platform,
        trader_key: t.trader_key,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return NextResponse.json({
    ok: true,
    polled,
    skipped_unsupported: tracked.length - eligible.length,
    changes_written: changesWritten,
    errors,
  })
}

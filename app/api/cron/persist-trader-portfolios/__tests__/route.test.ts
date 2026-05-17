/**
 * persist-trader-portfolios — pure-helper unit tests (CRYAA-2154).
 *
 * The route's IO surface (Supabase + live `fetchPortfolio`) is exercised by
 * downstream integration; here we lock down the deterministic pieces the
 * cron leans on: position normalization, snapshot envelope shape, and the
 * bounded-concurrency runner respecting input order.
 */

import { __test } from '../route'
import type { TraderPortfolio } from '@/lib/data/positions/types'

const { toSnapshot, normalizePosition, withConcurrency, FETCH_CONCURRENCY } = __test

describe('normalizePosition', () => {
  it('maps every TraderPortfolio.Position field to its snake_case snapshot field', () => {
    const out = normalizePosition({
      symbol: 'BTC',
      side: 'long',
      size: 0.42,
      entryPrice: 60000,
      markPrice: 61000,
      leverage: 5,
      notionalUsd: 25620,
      unrealizedPnlUsd: 420,
      liqPrice: 50000,
    })
    expect(out).toEqual({
      symbol: 'BTC',
      side: 'long',
      size: 0.42,
      entry_price: 60000,
      mark_price: 61000,
      leverage: 5,
      notional_usd: 25620,
      unrealized_pnl_usd: 420,
      liq_price: 50000,
    })
  })

  it('coerces missing optional fields to null', () => {
    const out = normalizePosition({
      symbol: 'ETH',
      side: 'short',
      size: 1.5,
      entryPrice: 3000,
      notionalUsd: 4500,
    })
    expect(out.mark_price).toBeNull()
    expect(out.leverage).toBeNull()
    expect(out.unrealized_pnl_usd).toBeNull()
    expect(out.liq_price).toBeNull()
  })

  it('passes NaN entry_price through as null', () => {
    const out = normalizePosition({
      symbol: 'BTC',
      side: 'long',
      size: 1,
      entryPrice: Number.NaN,
      notionalUsd: 0,
    })
    expect(out.entry_price).toBeNull()
  })
})

describe('toSnapshot', () => {
  it('emits the snapshot envelope shape the DAO expects', () => {
    const portfolio: TraderPortfolio = {
      platform: 'hyperliquid',
      traderKey: '0xabc',
      accountValueUsd: 100000,
      totalNotionalUsd: 250000,
      positions: [
        {
          symbol: 'BTC',
          side: 'long',
          size: 0.42,
          entryPrice: 60000,
          notionalUsd: 25200,
        },
      ],
      fetchedAt: '2026-05-17T15:00:00Z',
      source: 'hyperliquid-info',
    }

    const snap = toSnapshot(portfolio, '2026-05-17T15:00:00Z')

    expect(snap).toMatchObject({
      platform: 'hyperliquid',
      trader_key: '0xabc',
      captured_at: '2026-05-17T15:00:00Z',
      account_value_usd: 100000,
      total_notional_usd: 250000,
      source: 'hyperliquid-info',
    })
    expect(snap.positions).toHaveLength(1)
    expect(snap.positions[0]).toMatchObject({
      symbol: 'BTC',
      side: 'long',
      size: 0.42,
      entry_price: 60000,
      notional_usd: 25200,
    })
  })

  it('preserves null account_value_usd when the upstream omits it', () => {
    const portfolio: TraderPortfolio = {
      platform: 'gmx',
      traderKey: '0xg',
      totalNotionalUsd: 0,
      positions: [],
      fetchedAt: '2026-05-17T15:00:00Z',
      source: 'gmx-subsquid',
    }
    const snap = toSnapshot(portfolio, '2026-05-17T15:00:00Z')
    expect(snap.account_value_usd).toBeNull()
    expect(snap.positions).toEqual([])
  })
})

describe('withConcurrency', () => {
  it('preserves input order in the output array', async () => {
    const items = [3, 1, 2, 4]
    const out = await withConcurrency(items, 2, async (n) => {
      // Stagger so out-of-order completion would be observable if buggy.
      await new Promise((r) => setTimeout(r, n * 5))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20, 40])
  })

  it('runs at most `limit` workers concurrently', async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await withConcurrency(items, 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('returns immediately for an empty input', async () => {
    const out = await withConcurrency([], FETCH_CONCURRENCY, async () => 1)
    expect(out).toEqual([])
  })
})

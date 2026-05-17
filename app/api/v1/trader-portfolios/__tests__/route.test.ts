/**
 * /api/v1/trader-portfolios — pure-helper unit tests (CRYAA-2154).
 *
 * Covers the parse helpers and the envelope adapters; the live + snapshot
 * IO paths are exercised by route-level integration tests.
 */

import { __test } from '../route'
import type { TraderPortfolio } from '@/lib/data/positions/types'
import type { TraderPortfolioSnapshot } from '@/lib/data/portfolio-snapshots'

const { parseTraderKeys, parseSnapshotAt, normalizePosition, fromLive, fromSnapshot, MAX_TRADER_KEYS } =
  __test

describe('parseTraderKeys', () => {
  it('dedupes and trims', () => {
    const out = parseTraderKeys(' 0xA , 0xB ,0xA, 0xC')
    expect(out).toEqual(['0xA', '0xB', '0xC'])
  })

  it('rejects empty', () => {
    expect(parseTraderKeys(null)).toMatchObject({ error: expect.any(String) })
    expect(parseTraderKeys('')).toMatchObject({ error: expect.any(String) })
    expect(parseTraderKeys(' , ,')).toMatchObject({ error: expect.any(String) })
  })

  it(`rejects >${MAX_TRADER_KEYS} keys`, () => {
    const big = Array.from({ length: MAX_TRADER_KEYS + 1 }, (_, i) => `k${i}`).join(',')
    expect(parseTraderKeys(big)).toMatchObject({ error: expect.stringContaining('max=') })
  })
})

describe('parseSnapshotAt', () => {
  it('returns null for missing input', () => {
    expect(parseSnapshotAt(null)).toBeNull()
    expect(parseSnapshotAt('')).toBeNull()
  })

  it('parses a valid ISO timestamp', () => {
    const d = parseSnapshotAt('2026-05-16T12:00:00Z')
    expect(d).not.toBeNull()
    expect(d!.toISOString()).toBe('2026-05-16T12:00:00.000Z')
  })

  it('returns null for an invalid timestamp', () => {
    expect(parseSnapshotAt('not-a-date')).toBeNull()
  })
})

describe('fromLive', () => {
  it('coerces optional Position fields to null in the snake_case payload', () => {
    const live: TraderPortfolio = {
      platform: 'hyperliquid',
      traderKey: '0xabc',
      totalNotionalUsd: 25200,
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
    const out = fromLive(live, '2026-05-17T15:00:05Z')
    expect(out.platform).toBe('hyperliquid')
    expect(out.trader_key).toBe('0xabc')
    expect(out.account_value_usd).toBeNull()
    expect(out.last_captured_at).toBe('2026-05-17T15:00:00Z')
    expect(out.fetched_at).toBe('2026-05-17T15:00:05Z')
    expect(out.positions[0]).toMatchObject({
      symbol: 'BTC',
      side: 'long',
      entry_price: 60000,
      mark_price: null,
      leverage: null,
    })
  })
})

describe('fromSnapshot', () => {
  it('passes through stored snapshot fields and stamps fetched_at', () => {
    const snap: TraderPortfolioSnapshot = {
      platform: 'gmx',
      trader_key: '0xg',
      captured_at: '2026-05-16T11:00:00Z',
      account_value_usd: 100,
      total_notional_usd: 250,
      positions: [
        {
          symbol: 'ETH',
          side: 'short',
          size: 1,
          entry_price: 3000,
          notional_usd: 3000,
        },
      ],
      source: 'gmx-subsquid',
    }
    const out = fromSnapshot(snap, '2026-05-17T15:00:00Z')
    expect(out.platform).toBe('gmx')
    expect(out.last_captured_at).toBe('2026-05-16T11:00:00Z')
    expect(out.fetched_at).toBe('2026-05-17T15:00:00Z')
    expect(out.positions).toEqual(snap.positions)
    expect(out.source).toBe('gmx-subsquid')
  })

  it('defaults missing optionals on the snapshot envelope', () => {
    const snap: TraderPortfolioSnapshot = {
      platform: 'dydx',
      trader_key: '0xd',
      captured_at: '2026-05-16T11:00:00Z',
      positions: [],
    }
    const out = fromSnapshot(snap, '2026-05-17T15:00:00Z')
    expect(out.account_value_usd).toBeNull()
    expect(out.total_notional_usd).toBe(0)
    expect(out.source).toBeNull()
  })
})

describe('normalizePosition (entry_price guard)', () => {
  it('keeps a finite entry_price', () => {
    const p = normalizePosition({
      symbol: 'X',
      side: 'long',
      size: 1,
      entryPrice: 100,
      notionalUsd: 100,
    })
    expect(p.entry_price).toBe(100)
  })

  it('converts non-finite entry_price to null', () => {
    const p = normalizePosition({
      symbol: 'X',
      side: 'long',
      size: 1,
      entryPrice: Number.NaN,
      notionalUsd: 0,
    })
    expect(p.entry_price).toBeNull()
  })
})

/**
 * arena-eligible-pool — unit tests for the centralized eligibility predicate
 * (CRYAA-2118). Covers the four spec-named edge cases plus the regression
 * called out in the issue acceptance criteria:
 *
 *   - Window inactivity (`updated_at` older than the active window).
 *   - Fewer-than-N trades (`trades_count < 30`).
 *   - Null max_drawdown.
 *   - |max_drawdown| below the 0.5 floor.
 *   - Happy path.
 *   - Regression: a trader who would have made the old ROI-top-K pool but
 *     fails the new `trades_count >= 30` floor must be excluded.
 *   - Dedupe to latest snapshot per (platform, trader_key).
 *   - SQL query shape (asserts no ROI sort, no top-K cap, correct filters).
 */

import {
  ARENA_POOL_DEFAULTS,
  applyEligibilityPredicate,
  defaultActiveSince,
  fetchEligibleArenaPool,
  type ArenaEligibleRow,
} from '../arena-eligible-pool'
import type { SupabaseClient } from '@supabase/supabase-js'

const NOW = new Date('2026-05-17T12:00:00.000Z')
const ACTIVE_SINCE = new Date(NOW.getTime() - 24 * 3600 * 1000)

function makeRow(overrides: Partial<ArenaEligibleRow> = {}): ArenaEligibleRow {
  return {
    platform: 'hyperliquid',
    trader_key: '0xabc',
    roi_pct: 12.3,
    pnl_usd: 1234.5,
    max_drawdown: -2.5,
    trades_count: 100,
    arena_score: 1.5,
    sharpe_ratio: 1.2,
    updated_at: NOW.toISOString(),
    ...overrides,
  }
}

// ---------- applyEligibilityPredicate (in-memory, deterministic) ----------

describe('applyEligibilityPredicate — spec edge cases', () => {
  const baseCrit = {
    window: '90D' as const,
    minUpdatedAt: ACTIVE_SINCE,
  }

  it('happy path: passes a fully-eligible row', () => {
    const r = makeRow()
    expect(applyEligibilityPredicate([r], baseCrit)).toEqual([r])
  })

  it('excludes window-inactive rows (updated_at < minUpdatedAt)', () => {
    const stale = makeRow({
      trader_key: 'stale',
      updated_at: new Date(ACTIVE_SINCE.getTime() - 60_000).toISOString(),
    })
    const fresh = makeRow({ trader_key: 'fresh' })
    const out = applyEligibilityPredicate([stale, fresh], baseCrit)
    expect(out.map((r) => r.trader_key)).toEqual(['fresh'])
  })

  it('excludes rows with trades_count below the floor', () => {
    const low = makeRow({ trader_key: 'low', trades_count: 29 })
    const ok = makeRow({ trader_key: 'ok', trades_count: 30 })
    const out = applyEligibilityPredicate([low, ok], baseCrit)
    expect(out.map((r) => r.trader_key)).toEqual(['ok'])
  })

  it('excludes rows with null trades_count', () => {
    const nullTc = makeRow({ trader_key: 'nul', trades_count: null })
    const out = applyEligibilityPredicate([nullTc], baseCrit)
    expect(out).toEqual([])
  })

  it('excludes rows with null max_drawdown', () => {
    const nullDd = makeRow({ trader_key: 'nul', max_drawdown: null })
    const out = applyEligibilityPredicate([nullDd], baseCrit)
    expect(out).toEqual([])
  })

  it('excludes rows with |max_drawdown| below the 0.5 floor', () => {
    const tiny = makeRow({ trader_key: 'tiny', max_drawdown: -0.49 })
    const negEdge = makeRow({ trader_key: 'neg', max_drawdown: -0.5 })
    const posEdge = makeRow({ trader_key: 'pos', max_drawdown: 0.5 })
    const zero = makeRow({ trader_key: 'zero', max_drawdown: 0 })
    const out = applyEligibilityPredicate([tiny, negEdge, posEdge, zero], baseCrit)
    expect(out.map((r) => r.trader_key).sort()).toEqual(['neg', 'pos'])
  })

  it('honors caller-supplied N and drawdown floor overrides', () => {
    const r = makeRow({ trades_count: 50, max_drawdown: -1.0 })
    expect(applyEligibilityPredicate([r], { ...baseCrit, minTradesCount: 100 })).toEqual([])
    expect(
      applyEligibilityPredicate([r], { ...baseCrit, minAbsDrawdown: 5 }),
    ).toEqual([])
  })

  it('regression: high-ROI trader with insufficient trades is excluded', () => {
    // This trader would have made the old "top 5000 by roi_pct desc" pool
    // (huge ROI) but fails the new trades_count >= 30 floor and so must
    // not contribute to μ_pop / τ² estimation.
    const roiKing = makeRow({
      trader_key: 'roi_king',
      roi_pct: 9999, // top of the old ROI sort
      trades_count: 3, // brand-new account, no statistical weight
    })
    const out = applyEligibilityPredicate([roiKing], baseCrit)
    expect(out).toEqual([])
  })

  it('dedupes to the latest updated_at per (platform, trader_key)', () => {
    const older = makeRow({
      platform: 'hl',
      trader_key: 'dup',
      roi_pct: 1,
      updated_at: '2026-05-17T10:00:00.000Z',
    })
    const newer = makeRow({
      platform: 'hl',
      trader_key: 'dup',
      roi_pct: 2,
      updated_at: '2026-05-17T11:00:00.000Z',
    })
    const out = applyEligibilityPredicate([older, newer], baseCrit)
    expect(out).toHaveLength(1)
    expect(out[0].roi_pct).toBe(2)
  })

  it('platforms filter restricts the pool', () => {
    const hl = makeRow({ platform: 'hyperliquid' })
    const arena = makeRow({ platform: 'arena' })
    const out = applyEligibilityPredicate([hl, arena], { ...baseCrit, platforms: ['arena'] })
    expect(out.map((r) => r.platform)).toEqual(['arena'])
  })
})

// ---------- fetchEligibleArenaPool (Supabase query shape) ----------

interface ChainRecord {
  selectArgs: unknown[]
  eqArgs: Array<[string, unknown]>
  inArgs: Array<[string, unknown]>
  gteArgs: Array<[string, unknown]>
  orArgs: string[]
  notArgs: Array<[string, string, unknown]>
  orderArgs: Array<[string, unknown]>
  limitArgs: number[]
}

function mockSupabase(selectResolved: { data: unknown; error: unknown }): {
  client: SupabaseClient
  record: ChainRecord
} {
  const record: ChainRecord = {
    selectArgs: [],
    eqArgs: [],
    inArgs: [],
    gteArgs: [],
    orArgs: [],
    notArgs: [],
    orderArgs: [],
    limitArgs: [],
  }
  const chain: Record<string, unknown> = {
    select: jest.fn((arg?: unknown) => {
      record.selectArgs.push(arg)
      return chain
    }),
    eq: jest.fn((c: string, v: unknown) => {
      record.eqArgs.push([c, v])
      return chain
    }),
    in: jest.fn((c: string, v: unknown) => {
      record.inArgs.push([c, v])
      return chain
    }),
    gte: jest.fn((c: string, v: unknown) => {
      record.gteArgs.push([c, v])
      return chain
    }),
    not: jest.fn((c: string, op: string, v: unknown) => {
      record.notArgs.push([c, op, v])
      return chain
    }),
    or: jest.fn((expr: string) => {
      record.orArgs.push(expr)
      return chain
    }),
    order: jest.fn((c: string, args?: unknown) => {
      record.orderArgs.push([c, args])
      return chain
    }),
    limit: jest.fn((n: number) => {
      record.limitArgs.push(n)
      return chain
    }),
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(selectResolved).then(resolve),
  }
  const client = {
    from: jest.fn(() => chain),
  } as unknown as SupabaseClient
  return { client, record }
}

describe('fetchEligibleArenaPool — Supabase query shape', () => {
  it('applies window + active + trades_count + drawdown filters and no ROI sort', async () => {
    const { client, record } = mockSupabase({
      data: [makeRow()],
      error: null,
    })

    await fetchEligibleArenaPool(client, {
      window: '90D',
      minUpdatedAt: ACTIVE_SINCE,
    })

    // window filter
    expect(record.eqArgs).toEqual(expect.arrayContaining([['window', '90D']]))
    // active-in-window filter
    const gteUpdatedAt = record.gteArgs.find(([c]) => c === 'updated_at')
    expect(gteUpdatedAt?.[1]).toBe(ACTIVE_SINCE.toISOString())
    // trades_count floor
    const gteTrades = record.gteArgs.find(([c]) => c === 'trades_count')
    expect(gteTrades?.[1]).toBe(ARENA_POOL_DEFAULTS.minTradesCount)
    // max_drawdown IS NOT NULL
    expect(record.notArgs).toEqual(expect.arrayContaining([['max_drawdown', 'is', null]]))
    // |max_drawdown| >= 0.5 via OR
    expect(record.orArgs).toEqual([`max_drawdown.gte.0.5,max_drawdown.lte.-0.5`])
    // No ROI sort at all
    expect(record.orderArgs.some(([c]) => c === 'roi_pct')).toBe(false)
    // Ordering is by updated_at (dedupe-only)
    expect(record.orderArgs).toEqual(
      expect.arrayContaining([['updated_at', { ascending: false }]]),
    )
    // No top-5000 ROI cap — the only limit is the safety cap, well above 5k
    expect(record.limitArgs.every((n) => n >= 5000)).toBe(true)
    expect(record.limitArgs[0]).toBeGreaterThanOrEqual(100000)
  })

  it('passes the platforms list through', async () => {
    const { client, record } = mockSupabase({ data: [], error: null })
    await fetchEligibleArenaPool(client, {
      window: '7D',
      minUpdatedAt: ACTIVE_SINCE,
      platforms: ['hyperliquid', 'arena'],
    })
    expect(record.inArgs).toEqual([['platform', ['hyperliquid', 'arena']]])
  })

  it('throws when Supabase reports an error', async () => {
    const { client } = mockSupabase({
      data: null,
      error: { message: 'connection refused' },
    })
    await expect(
      fetchEligibleArenaPool(client, { window: '90D', minUpdatedAt: ACTIVE_SINCE }),
    ).rejects.toThrow(/connection refused/)
  })

  it('dedupes raw query result to one row per (platform, trader_key)', async () => {
    const { client } = mockSupabase({
      data: [
        makeRow({
          platform: 'hl',
          trader_key: 'dup',
          updated_at: '2026-05-17T10:00:00.000Z',
          roi_pct: 1,
        }),
        makeRow({
          platform: 'hl',
          trader_key: 'dup',
          updated_at: '2026-05-17T11:00:00.000Z',
          roi_pct: 2,
        }),
        makeRow({ platform: 'hl', trader_key: 'solo' }),
      ],
      error: null,
    })
    const out = await fetchEligibleArenaPool(client, {
      window: '90D',
      minUpdatedAt: ACTIVE_SINCE,
    })
    expect(out).toHaveLength(2)
    const dup = out.find((r) => r.trader_key === 'dup')
    expect(dup?.roi_pct).toBe(2)
  })
})

describe('defaultActiveSince', () => {
  it('returns NOW − 24h', () => {
    const now = new Date('2026-05-17T12:00:00Z')
    expect(defaultActiveSince(now).toISOString()).toBe('2026-05-16T12:00:00.000Z')
  })
})

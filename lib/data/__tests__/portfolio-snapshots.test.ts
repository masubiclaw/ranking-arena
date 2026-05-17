/**
 * portfolio-snapshots DAO — unit tests (CRYAA-2154)
 *
 * Mirrors the shrinkage-snapshots harness: a chainable Supabase stub captures
 * method calls so we can assert on the query shape, then resolves the terminal
 * `await q` with the configured rows. Covers insert/upsert key, batch
 * time-travel including the no-snapshot path, latestForPlatform freshness and
 * dedup, and the retention helper.
 */

import {
  insertBatch,
  findAtOrBeforeBatch,
  latestForPlatform,
  newestCapturedAt,
  pruneOlderThan,
  type TraderPortfolioSnapshot,
} from '../portfolio-snapshots'
import type { SupabaseClient } from '@supabase/supabase-js'

interface ChainRecord {
  upsertArgs?: { rows: unknown; args: { onConflict: string; ignoreDuplicates: boolean } }
  selectArgs: unknown[]
  eqArgs: Array<[string, unknown]>
  inArgs: Array<[string, unknown]>
  gteArgs: Array<[string, unknown]>
  lteArgs: Array<[string, unknown]>
  ltArgs: Array<[string, unknown]>
  orderArgs: Array<[string, unknown]>
  limitArgs: number[]
  deleteCalled: boolean
}

interface QueueEntry {
  data: unknown
  error: unknown
}

function mockSupabase(opts: {
  // FIFO queue of resolutions for sequential `await q` calls — needed for
  // findAtOrBeforeBatch, which queries once per platform.
  selectResolutions?: QueueEntry[]
  selectResolved?: QueueEntry
  maybeSingleResolved?: QueueEntry
}): { client: SupabaseClient; record: ChainRecord } {
  const record: ChainRecord = {
    selectArgs: [],
    eqArgs: [],
    inArgs: [],
    gteArgs: [],
    lteArgs: [],
    ltArgs: [],
    orderArgs: [],
    limitArgs: [],
    deleteCalled: false,
  }

  const queue: QueueEntry[] = opts.selectResolutions
    ? [...opts.selectResolutions]
    : opts.selectResolved
      ? [opts.selectResolved]
      : []
  const fallback: QueueEntry = { data: [], error: null }
  const maybeSingleResolved = opts.maybeSingleResolved ?? { data: null, error: null }

  const chain: Record<string, unknown> = {
    select: jest.fn((arg?: unknown) => {
      record.selectArgs.push(arg)
      return chain
    }),
    upsert: jest.fn((rows: unknown, args?: unknown) => {
      record.upsertArgs = {
        rows,
        args: args as { onConflict: string; ignoreDuplicates: boolean },
      }
      return chain
    }),
    delete: jest.fn(() => {
      record.deleteCalled = true
      return chain
    }),
    eq: jest.fn((col: string, val: unknown) => {
      record.eqArgs.push([col, val])
      return chain
    }),
    in: jest.fn((col: string, val: unknown) => {
      record.inArgs.push([col, val])
      return chain
    }),
    gte: jest.fn((col: string, val: unknown) => {
      record.gteArgs.push([col, val])
      return chain
    }),
    lte: jest.fn((col: string, val: unknown) => {
      record.lteArgs.push([col, val])
      return chain
    }),
    lt: jest.fn((col: string, val: unknown) => {
      record.ltArgs.push([col, val])
      return chain
    }),
    order: jest.fn((col: string, args?: unknown) => {
      record.orderArgs.push([col, args])
      return chain
    }),
    limit: jest.fn((n: number) => {
      record.limitArgs.push(n)
      return chain
    }),
    maybeSingle: jest.fn(async () => maybeSingleResolved),
    then: (resolve: (v: QueueEntry) => unknown) => {
      const next = queue.length > 0 ? (queue.shift() as QueueEntry) : fallback
      return Promise.resolve(next).then(resolve)
    },
  }

  const client = {
    from: jest.fn(() => chain),
  } as unknown as SupabaseClient

  return { client, record }
}

function snap(overrides: Partial<TraderPortfolioSnapshot> = {}): TraderPortfolioSnapshot {
  return {
    platform: 'hyperliquid',
    trader_key: '0xabc',
    captured_at: '2026-05-16T12:00:00Z',
    account_value_usd: 12345,
    total_notional_usd: 67890,
    positions: [
      {
        symbol: 'BTC',
        side: 'long',
        size: 0.42,
        entry_price: 60000,
        notional_usd: 25200,
      },
    ],
    source: 'hyperliquid-info',
    ...overrides,
  }
}

// ============================================
// insertBatch
// ============================================

describe('insertBatch', () => {
  it('upserts on the hourly key and returns the number of rows', async () => {
    const rows = [snap({ trader_key: '0xA' }), snap({ trader_key: '0xB' })]
    const { client, record } = mockSupabase({
      selectResolved: { data: [{ id: 1 }, { id: 2 }], error: null },
    })

    const n = await insertBatch(rows, { client })

    expect(n).toBe(2)
    expect(record.upsertArgs).toBeDefined()
    expect(record.upsertArgs!.rows).toEqual(rows)
    expect(record.upsertArgs!.args.onConflict).toBe(
      "platform,trader_key,date_trunc('hour', captured_at AT TIME ZONE 'UTC')"
    )
    expect(record.upsertArgs!.args.ignoreDuplicates).toBe(false)
  })

  it('returns 0 and does not call supabase for an empty batch', async () => {
    const { client, record } = mockSupabase({})
    const n = await insertBatch([], { client })
    expect(n).toBe(0)
    expect(record.upsertArgs).toBeUndefined()
  })

  it('throws when supabase returns an error', async () => {
    const { client } = mockSupabase({
      selectResolved: { data: null, error: { message: 'unique violation' } },
    })
    await expect(insertBatch([snap()], { client })).rejects.toThrow(/unique violation/)
  })
})

// ============================================
// findAtOrBeforeBatch
// ============================================

describe('findAtOrBeforeBatch', () => {
  it('returns the closest at-or-before snapshot per trader and applies lte cutoff', async () => {
    const cutoff = new Date('2026-05-16T12:00:00Z')
    // Same platform, two traders, two timestamps for trader 0xA.
    const rows = [
      snap({ trader_key: '0xA', captured_at: '2026-05-16T11:00:00Z' }),
      snap({ trader_key: '0xA', captured_at: '2026-05-15T11:00:00Z' }),
      snap({ trader_key: '0xB', captured_at: '2026-05-14T20:00:00Z' }),
    ]
    const { client, record } = mockSupabase({
      selectResolutions: [{ data: rows, error: null }],
    })

    const out = await findAtOrBeforeBatch(
      [
        { platform: 'hyperliquid', trader_key: '0xA' },
        { platform: 'hyperliquid', trader_key: '0xB' },
      ],
      cutoff,
      { client }
    )

    expect(record.lteArgs).toEqual([['captured_at', cutoff.toISOString()]])
    expect(record.inArgs).toEqual([['trader_key', ['0xA', '0xB']]])
    expect(record.eqArgs).toEqual([['platform', 'hyperliquid']])

    const a = out.get('hyperliquid:0xA')
    const b = out.get('hyperliquid:0xB')
    expect(a?.captured_at).toBe('2026-05-16T11:00:00Z')
    expect(b?.captured_at).toBe('2026-05-14T20:00:00Z')
  })

  it('marks traders with no snapshot before cutoff as null', async () => {
    const { client } = mockSupabase({
      selectResolutions: [{ data: [], error: null }],
    })
    const out = await findAtOrBeforeBatch(
      [{ platform: 'hyperliquid', trader_key: '0xMissing' }],
      new Date('2020-01-01T00:00:00Z'),
      { client }
    )
    expect(out.get('hyperliquid:0xMissing')).toBeNull()
  })

  it('issues one query per platform and merges results', async () => {
    const cutoff = new Date('2026-05-16T12:00:00Z')
    const { client, record } = mockSupabase({
      selectResolutions: [
        {
          data: [snap({ platform: 'hyperliquid', trader_key: '0xA', captured_at: '2026-05-16T08:00:00Z' })],
          error: null,
        },
        {
          data: [snap({ platform: 'gmx', trader_key: '0xG', captured_at: '2026-05-16T09:00:00Z' })],
          error: null,
        },
      ],
    })

    const out = await findAtOrBeforeBatch(
      [
        { platform: 'hyperliquid', trader_key: '0xA' },
        { platform: 'gmx', trader_key: '0xG' },
      ],
      cutoff,
      { client }
    )

    expect(record.eqArgs).toEqual([
      ['platform', 'hyperliquid'],
      ['platform', 'gmx'],
    ])
    expect(out.get('hyperliquid:0xA')?.captured_at).toBe('2026-05-16T08:00:00Z')
    expect(out.get('gmx:0xG')?.captured_at).toBe('2026-05-16T09:00:00Z')
  })

  it('returns an empty map for an empty request set', async () => {
    const { client, record } = mockSupabase({})
    const out = await findAtOrBeforeBatch([], new Date(), { client })
    expect(out.size).toBe(0)
    expect(record.eqArgs).toEqual([])
  })
})

// ============================================
// latestForPlatform
// ============================================

describe('latestForPlatform', () => {
  it('collapses duplicates to the newest row per trader_key', async () => {
    const rows = [
      snap({ trader_key: '0xA', captured_at: '2026-05-16T12:00:00Z' }),
      snap({ trader_key: '0xA', captured_at: '2026-05-15T12:00:00Z' }),
      snap({ trader_key: '0xB', captured_at: '2026-05-14T12:00:00Z' }),
    ]
    const { client } = mockSupabase({ selectResolved: { data: rows, error: null } })

    const out = await latestForPlatform('hyperliquid', { client })

    expect(out).toHaveLength(2)
    expect(out[0].captured_at).toBe('2026-05-16T12:00:00Z')
    expect(out[1].trader_key).toBe('0xB')
  })

  it('applies maxAgeSeconds as a gte cutoff', async () => {
    const now = new Date('2026-05-16T12:00:00Z')
    const { client, record } = mockSupabase({ selectResolved: { data: [], error: null } })
    await latestForPlatform('hyperliquid', { client, maxAgeSeconds: 7200, now })
    expect(record.gteArgs).toEqual([
      ['captured_at', new Date(now.getTime() - 7200 * 1000).toISOString()],
    ])
  })
})

// ============================================
// newestCapturedAt
// ============================================

describe('newestCapturedAt', () => {
  it('returns the newest captured_at when a row exists', async () => {
    const { client } = mockSupabase({
      maybeSingleResolved: {
        data: { captured_at: '2026-05-16T12:00:00Z' },
        error: null,
      },
    })
    expect(await newestCapturedAt({ client })).toBe('2026-05-16T12:00:00Z')
  })

  it('returns null when the table is empty', async () => {
    const { client } = mockSupabase({
      maybeSingleResolved: { data: null, error: null },
    })
    expect(await newestCapturedAt({ client })).toBeNull()
  })
})

// ============================================
// pruneOlderThan
// ============================================

describe('pruneOlderThan', () => {
  it('deletes rows with captured_at older than now - days*86400', async () => {
    const now = new Date('2026-05-16T12:00:00Z')
    const { client, record } = mockSupabase({
      selectResolved: { data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null },
    })
    const n = await pruneOlderThan(90, { client, now })
    expect(n).toBe(3)
    expect(record.deleteCalled).toBe(true)
    expect(record.ltArgs).toEqual([
      ['captured_at', new Date(now.getTime() - 90 * 86400 * 1000).toISOString()],
    ])
  })

  it('returns 0 and does not query when days <= 0', async () => {
    const { client, record } = mockSupabase({})
    expect(await pruneOlderThan(0, { client })).toBe(0)
    expect(record.deleteCalled).toBe(false)
  })
})

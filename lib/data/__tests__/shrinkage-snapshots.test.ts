/**
 * shrinkage-snapshots DAO — unit tests
 *
 * Covers insert/read round-trip semantics, freshness + platform filtering on
 * `latestForWindow`, and the at-or-before time-travel rule on
 * `findAtOrBefore` (including the "no row before timestamp" path that the
 * snapshot endpoint will translate to HTTP 404).
 *
 * Supabase is mocked via a chainable builder that captures method calls so we
 * can assert on the query shape (filters applied) as well as the returned
 * data.
 */

import {
  insertBatch,
  latestForWindow,
  newestComputedAt,
  findAtOrBefore,
  type TraderShrinkageSnapshot,
} from '../shrinkage-snapshots'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---- Helpers ----

interface ChainRecord {
  upsertArgs?: unknown
  selectArgs: unknown[]
  eqArgs: Array<[string, unknown]>
  inArgs: Array<[string, unknown]>
  gteArgs: Array<[string, unknown]>
  lteArgs: Array<[string, unknown]>
  orderArgs: Array<[string, unknown]>
  limitArgs: number[]
}

function mockSupabase(opts: {
  selectResolved?: { data: unknown; error: unknown }
  maybeSingleResolved?: { data: unknown; error: unknown }
}): { client: SupabaseClient; record: ChainRecord } {
  const record: ChainRecord = {
    selectArgs: [],
    eqArgs: [],
    inArgs: [],
    gteArgs: [],
    lteArgs: [],
    orderArgs: [],
    limitArgs: [],
  }

  const selectResolved = opts.selectResolved ?? { data: [], error: null }
  const maybeSingleResolved = opts.maybeSingleResolved ?? { data: null, error: null }

  // The same chain object handles both terminal awaits (await q at the end of
  // the query) and explicit `.maybeSingle()` calls.
  const chain: Record<string, unknown> = {
    select: jest.fn((arg?: unknown) => {
      record.selectArgs.push(arg)
      return chain
    }),
    upsert: jest.fn((rows: unknown, args?: unknown) => {
      record.upsertArgs = { rows, args }
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
    order: jest.fn((col: string, args?: unknown) => {
      record.orderArgs.push([col, args])
      return chain
    }),
    limit: jest.fn((n: number) => {
      record.limitArgs.push(n)
      return chain
    }),
    maybeSingle: jest.fn(async () => maybeSingleResolved),
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(selectResolved).then(resolve),
  }

  const client = {
    from: jest.fn(() => chain),
  } as unknown as SupabaseClient

  return { client, record }
}

function snap(
  overrides: Partial<TraderShrinkageSnapshot> = {}
): TraderShrinkageSnapshot {
  return {
    window: '90D',
    platform: 'hyperliquid',
    trader_key: '0xabc',
    observed: 1.23,
    shrunk: 0.92,
    posterior_sd: 0.45,
    weight_to_prior: 0.31,
    p_superforecaster: 0.78,
    mu_pop: 0.5,
    tau_sq: 0.9,
    eligible_n: 4500,
    sf_threshold: 1.6,
    sf_fraction: 0.05,
    computed_at: '2026-05-16T12:00:00Z',
    ...overrides,
  }
}

// ============================================
// insertBatch
// ============================================

describe('insertBatch', () => {
  it('upserts on the daily key and returns the number of rows', async () => {
    const rows = [snap({ trader_key: '0xA' }), snap({ trader_key: '0xB' })]
    const { client, record } = mockSupabase({
      selectResolved: { data: [{ id: 1 }, { id: 2 }], error: null },
    })

    const n = await insertBatch(rows, { client })

    expect(n).toBe(2)
    const { rows: sentRows, args } = record.upsertArgs as {
      rows: unknown
      args: { onConflict: string; ignoreDuplicates: boolean }
    }
    expect(sentRows).toEqual(rows)
    expect(args.onConflict).toBe(
      "window,platform,trader_key,(computed_at AT TIME ZONE 'UTC')::date"
    )
    expect(args.ignoreDuplicates).toBe(false)
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
// latestForWindow
// ============================================

describe('latestForWindow', () => {
  it('round-trips a single insert via the same mock backing', async () => {
    const row = snap()
    const { client, record } = mockSupabase({ selectResolved: { data: [row], error: null } })

    const out = await latestForWindow('90D', { client })

    expect(out).toEqual([row])
    expect(record.eqArgs).toEqual([['window', '90D']])
    expect(record.orderArgs[0][0]).toBe('computed_at')
  })

  it('filters by platforms whitelist when provided', async () => {
    const { client, record } = mockSupabase({ selectResolved: { data: [], error: null } })
    await latestForWindow('30D', { client, platforms: ['hyperliquid', 'gmx'] })
    expect(record.inArgs).toEqual([['platform', ['hyperliquid', 'gmx']]])
  })

  it('omits the `in` filter when no platforms passed', async () => {
    const { client, record } = mockSupabase({ selectResolved: { data: [], error: null } })
    await latestForWindow('30D', { client })
    expect(record.inArgs).toEqual([])
  })

  it('applies maxAgeSeconds as a gte cutoff', async () => {
    const now = new Date('2026-05-16T12:00:00Z')
    const { client, record } = mockSupabase({ selectResolved: { data: [], error: null } })
    await latestForWindow('90D', { client, maxAgeSeconds: 7200, now })
    expect(record.gteArgs).toEqual([
      ['computed_at', new Date(now.getTime() - 7200 * 1000).toISOString()],
    ])
  })

  it('collapses duplicates to the newest row per (platform, trader_key)', async () => {
    // Driver returns rows in desc order; both rows share the same key.
    const rows = [
      snap({ computed_at: '2026-05-16T12:00:00Z' }),
      snap({ computed_at: '2026-05-15T12:00:00Z' }),
      snap({ trader_key: '0xother', computed_at: '2026-05-14T12:00:00Z' }),
    ]
    const { client } = mockSupabase({ selectResolved: { data: rows, error: null } })

    const out = await latestForWindow('90D', { client })

    expect(out).toHaveLength(2)
    expect(out[0].computed_at).toBe('2026-05-16T12:00:00Z')
    expect(out[1].trader_key).toBe('0xother')
  })
})

// ============================================
// newestComputedAt
// ============================================

describe('newestComputedAt', () => {
  it('returns the newest computed_at when a row exists', async () => {
    const { client } = mockSupabase({
      maybeSingleResolved: {
        data: { computed_at: '2026-05-16T12:00:00Z' },
        error: null,
      },
    })
    const out = await newestComputedAt('90D', { client })
    expect(out).toBe('2026-05-16T12:00:00Z')
  })

  it('returns null when no rows exist for the window', async () => {
    const { client } = mockSupabase({
      maybeSingleResolved: { data: null, error: null },
    })
    const out = await newestComputedAt('90D', { client })
    expect(out).toBeNull()
  })
})

// ============================================
// findAtOrBefore
// ============================================

describe('findAtOrBefore', () => {
  it('applies lte(snapshotAt) and returns the closest at-or-before row per trader', async () => {
    const cutoff = new Date('2026-05-16T12:00:00Z')
    // Driver returns desc rows; the first row per trader_key is the closest before cutoff.
    const rows = [
      snap({ computed_at: '2026-05-16T11:00:00Z' }),
      snap({ computed_at: '2026-05-15T10:00:00Z' }),
      snap({ trader_key: '0xB', computed_at: '2026-05-15T08:00:00Z' }),
    ]
    const { client, record } = mockSupabase({ selectResolved: { data: rows, error: null } })

    const out = await findAtOrBefore('90D', cutoff, { client })

    expect(record.lteArgs).toEqual([['computed_at', cutoff.toISOString()]])
    expect(out).not.toBeNull()
    expect(out!).toHaveLength(2)
    expect(out![0].computed_at).toBe('2026-05-16T11:00:00Z')
    expect(out![1].trader_key).toBe('0xB')
  })

  it('returns null when no rows exist at or before the snapshotAt', async () => {
    const { client } = mockSupabase({ selectResolved: { data: [], error: null } })
    const out = await findAtOrBefore('90D', new Date('2020-01-01T00:00:00Z'), { client })
    expect(out).toBeNull()
  })

  it('honors the platforms whitelist', async () => {
    const { client, record } = mockSupabase({ selectResolved: { data: [], error: null } })
    await findAtOrBefore('90D', new Date(), { client, platforms: ['hyperliquid'] })
    expect(record.inArgs).toEqual([['platform', ['hyperliquid']]])
  })
})

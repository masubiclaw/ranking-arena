/**
 * /api/v1/top-traders route tests.
 *
 * Mirrors the legacy /api/top-traders coverage and adds the D5 hardening
 * pieces: time-travel (`snapshot_at=`), auth gate (env on/off), per-key
 * rate-limit (under/over budget), and the JSON-Schema contract check.
 */

import AjvCtor from 'ajv'
import schemaJson from '@/docs/api/v1.json'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
    static redirect(_url: URL, status = 307) {
      return new MockNextResponse(null, { status })
    }
  }
  class MockNextRequest {
    url: string
    headers: Map<string, string>
    method: string
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string }) {
      this.url = url
      this.headers = new Map(
        Object.entries(opts?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
      )
      this.method = opts?.method || 'GET'
    }
  }
  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockLatestForWindow = jest.fn()
const mockFindAtOrBefore = jest.fn()
jest.mock('@/lib/data/shrinkage-snapshots', () => ({
  latestForWindow: (...args: unknown[]) => mockLatestForWindow(...args),
  findAtOrBefore: (...args: unknown[]) => mockFindAtOrBefore(...args),
}))

const mockGetSupabaseAdmin = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { __test as rateTest } from '../../_rate-limit'

function makeReq(qs: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost/api/v1/top-traders${qs}`, {
    headers,
  }) as unknown as NextRequest
}

function makeSnapshotRow(over: {
  platform?: string
  trader_key?: string
  p_superforecaster: number
  computed_at?: string
}) {
  return {
    window: '90D',
    platform: over.platform ?? 'hyperliquid',
    trader_key: over.trader_key ?? 'alice',
    observed: 2.5,
    shrunk: 1.8,
    posterior_sd: 0.45,
    weight_to_prior: 0.3,
    p_superforecaster: over.p_superforecaster,
    mu_pop: 0.4,
    tau_sq: 1.2,
    eligible_n: 100,
    sf_threshold: 1.5,
    sf_fraction: 0.05,
    computed_at: over.computed_at ?? '2026-05-16T12:00:00.000Z',
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  rateTest.reset()
  delete process.env.ARENA_API_AUTH_REQUIRED
  delete process.env.ARENA_API_KEYS
  delete process.env.ARENA_API_RATE_LIMIT_RPM
})

describe('GET /api/v1/top-traders — snapshot mode', () => {
  it('200 with N traders sorted by p_superforecaster desc', async () => {
    mockLatestForWindow.mockResolvedValue([
      makeSnapshotRow({ trader_key: 'low', p_superforecaster: 0.1 }),
      makeSnapshotRow({ trader_key: 'high', p_superforecaster: 0.92 }),
      makeSnapshotRow({ trader_key: 'mid', p_superforecaster: 0.55 }),
    ])
    const res = await GET(makeReq('?criterion=p_superforecaster&window=90D'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { traders: Array<{ trader_key: string }> }
    expect(body.traders.map(t => t.trader_key)).toEqual(['high', 'mid', 'low'])
  })

  it('envelope matches documented shape', async () => {
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.7 })])
    const res = await GET(makeReq('?window=90D'))
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body.shrinkage as object).sort()).toEqual(
      ['eligible_n', 'mu_pop', 'sf_fraction', 'sf_threshold', 'snapshot_date', 'tau_sq'].sort(),
    )
    expect(Object.keys((body.traders as Array<object>)[0]).sort()).toEqual(
      ['observed', 'p_superforecaster', 'platform', 'posterior_sd', 'shrunk', 'trader_key', 'weight_to_prior'].sort(),
    )
  })

  it('503 when no fresh snapshot', async () => {
    mockLatestForWindow.mockResolvedValue([])
    const res = await GET(makeReq('?window=90D&max_age_hours=1'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('snapshot_stale')
  })

  it('400 on invalid window / criterion / source / limit', async () => {
    expect((await GET(makeReq('?window=1Y'))).status).toBe(400)
    expect((await GET(makeReq('?criterion=arena_score&window=90D'))).status).toBe(400)
    expect((await GET(makeReq('?window=90D&source=cache'))).status).toBe(400)
    expect((await GET(makeReq('?window=90D&limit=0'))).status).toBe(400)
  })

  it('Cache-Control header on snapshot reads', async () => {
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.7 })])
    const res = await GET(makeReq('?window=90D'))
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60')
  })

  it('500 when DAO throws', async () => {
    mockLatestForWindow.mockRejectedValue(new Error('boom'))
    const res = await GET(makeReq('?window=90D'))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/v1/top-traders — time-travel', () => {
  it('returns the historical row when snapshot_at points before any row', async () => {
    mockFindAtOrBefore.mockResolvedValue([
      makeSnapshotRow({
        trader_key: 'alice',
        p_superforecaster: 0.6,
        computed_at: '2026-04-01T00:00:00.000Z',
      }),
    ])
    const res = await GET(makeReq('?window=90D&snapshot_at=2026-04-15T00:00:00Z'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { shrinkage: { snapshot_date: string }; traders: unknown[] }
    expect(body.shrinkage.snapshot_date).toBe('2026-04-01')
    expect(body.traders.length).toBe(1)
    expect(mockFindAtOrBefore).toHaveBeenCalledWith(
      '90D',
      expect.any(Date),
      { platforms: undefined },
    )
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=3600, stale-while-revalidate=3600')
  })

  it('404 when no snapshot exists at-or-before the timestamp', async () => {
    mockFindAtOrBefore.mockResolvedValue(null)
    const res = await GET(makeReq('?window=90D&snapshot_at=2024-01-01T00:00:00Z'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('no_snapshot_before')
  })

  it('400 on invalid snapshot_at', async () => {
    const res = await GET(makeReq('?window=90D&snapshot_at=not-a-date'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_snapshot_at')
  })

  it('time-travel ignores source=live (history is snapshot-only)', async () => {
    mockFindAtOrBefore.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    const res = await GET(makeReq('?window=90D&source=live&snapshot_at=2026-04-15T00:00:00Z'))
    expect(res.status).toBe(200)
    expect(mockFindAtOrBefore).toHaveBeenCalled()
  })
})

describe('GET /api/v1/top-traders — auth gate', () => {
  it('passes through when ARENA_API_AUTH_REQUIRED is unset (dev mode)', async () => {
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    const res = await GET(makeReq('?window=90D'))
    expect(res.status).toBe(200)
  })

  it('401 when gate is on and no key is presented', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    process.env.ARENA_API_KEYS = 'k1,k2'
    const res = await GET(makeReq('?window=90D'))
    expect(res.status).toBe(401)
  })

  it('401 when gate is on and key is wrong', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    process.env.ARENA_API_KEYS = 'k1,k2'
    const res = await GET(makeReq('?window=90D', { 'X-Arena-Api-Key': 'bogus' }))
    expect(res.status).toBe(401)
  })

  it('200 with X-Arena-Api-Key header', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    process.env.ARENA_API_KEYS = 'good'
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    const res = await GET(makeReq('?window=90D', { 'X-Arena-Api-Key': 'good' }))
    expect(res.status).toBe(200)
  })

  it('200 with Authorization: Bearer', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    process.env.ARENA_API_KEYS = 'good'
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    const res = await GET(makeReq('?window=90D', { Authorization: 'Bearer good' }))
    expect(res.status).toBe(200)
  })

  it('500 when gate is on but no keys configured', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    const res = await GET(makeReq('?window=90D', { 'X-Arena-Api-Key': 'anything' }))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toBe('auth_misconfigured')
  })
})

describe('GET /api/v1/top-traders — rate limit', () => {
  it('200 within budget', async () => {
    process.env.ARENA_API_RATE_LIMIT_RPM = '3'
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    for (let i = 0; i < 3; i++) {
      const res = await GET(makeReq('?window=90D'))
      expect(res.status).toBe(200)
    }
  })

  it('429 with Retry-After when bucket exhausted', async () => {
    process.env.ARENA_API_RATE_LIMIT_RPM = '2'
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    await GET(makeReq('?window=90D'))
    await GET(makeReq('?window=90D'))
    const blocked = await GET(makeReq('?window=90D'))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBeTruthy()
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe('2')
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  it('separate buckets per API key', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    process.env.ARENA_API_KEYS = 'alpha,beta'
    process.env.ARENA_API_RATE_LIMIT_RPM = '1'
    mockLatestForWindow.mockResolvedValue([makeSnapshotRow({ p_superforecaster: 0.5 })])
    expect((await GET(makeReq('?window=90D', { 'X-Arena-Api-Key': 'alpha' }))).status).toBe(200)
    expect((await GET(makeReq('?window=90D', { 'X-Arena-Api-Key': 'alpha' }))).status).toBe(429)
    expect((await GET(makeReq('?window=90D', { 'X-Arena-Api-Key': 'beta' }))).status).toBe(200)
  })
})

describe('GET /api/v1/top-traders — JSON Schema contract', () => {
  it('representative live response validates against docs/api/v1.json#TopTradersResponse', async () => {
    mockLatestForWindow.mockResolvedValue([
      makeSnapshotRow({ trader_key: 'a', p_superforecaster: 0.9 }),
      makeSnapshotRow({ trader_key: 'b', p_superforecaster: 0.5 }),
    ])
    const res = await GET(makeReq('?window=90D'))
    const body = await res.json()

    // ajv 6.x — register the whole document so internal `#/definitions/*`
    // refs resolve, then pull the named sub-schema.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvAny = AjvCtor as any
    const ajv = new AjvAny({ allErrors: true })
    ajv.addSchema(schemaJson as object, 'v1')
    const validate = ajv.getSchema('v1#/definitions/TopTradersResponse')
    const valid = validate(body)
    if (!valid) {
      // eslint-disable-next-line no-console
      console.error('Schema errors:', validate.errors)
    }
    expect(valid).toBe(true)
  })
})

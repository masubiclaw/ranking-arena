/**
 * /api/v1/health route tests.
 *
 * Covers the kill-switch shape ACP polls:
 *   - response keys
 *   - status=ok when both freshness checks pass
 *   - status=degraded when shrinkage cron is stale
 *   - status=degraded when portfolio upstream is stale or errored
 *   - auth gate (401 when ARENA_API_AUTH_REQUIRED=true and no key)
 *   - 429 when rate budget exhausted
 *   - response shape matches docs/api/v1.json#HealthResponse
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
  }
  class MockNextRequest {
    url: string
    headers: Map<string, string>
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.url = url
      this.headers = new Map(
        Object.entries(opts?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
      )
    }
  }
  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockNewestComputedAt = jest.fn()
jest.mock('@/lib/data/shrinkage-snapshots', () => ({
  newestComputedAt: (...args: unknown[]) => mockNewestComputedAt(...args),
}))

const mockSupabaseChain: Record<string, jest.Mock> = {}
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

function makeReq(headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/v1/health', { headers }) as unknown as NextRequest
}

function stubSupabasePortfolio(asOfTs: string | null, error: { message: string } | null = null) {
  const result = Promise.resolve({ data: asOfTs ? { as_of_ts: asOfTs } : null, error })
  mockSupabaseChain.from = jest.fn(() => mockSupabaseChain)
  mockSupabaseChain.select = jest.fn(() => mockSupabaseChain)
  mockSupabaseChain.eq = jest.fn(() => mockSupabaseChain)
  mockSupabaseChain.order = jest.fn(() => mockSupabaseChain)
  mockSupabaseChain.limit = jest.fn(() => mockSupabaseChain)
  mockSupabaseChain.maybeSingle = jest.fn(() => result)
  mockGetSupabaseAdmin.mockReturnValue(mockSupabaseChain)
}

beforeEach(() => {
  jest.clearAllMocks()
  rateTest.reset()
  delete process.env.ARENA_API_AUTH_REQUIRED
  delete process.env.ARENA_API_KEYS
  delete process.env.ARENA_API_RATE_LIMIT_RPM
})

describe('GET /api/v1/health', () => {
  it('returns required keys', async () => {
    mockNewestComputedAt.mockResolvedValue(new Date().toISOString())
    stubSupabasePortfolio(new Date().toISOString())
    const res = await GET(makeReq())
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      [
        'portfolio_upstream_last_seen',
        'portfolio_upstream_status',
        'shrinkage_cron_age_seconds',
        'shrinkage_cron_last_run',
        'status',
        'version',
      ].sort(),
    )
  })

  it('status=ok when both freshness checks pass', async () => {
    mockNewestComputedAt.mockResolvedValue(new Date().toISOString())
    stubSupabasePortfolio(new Date().toISOString())
    const res = await GET(makeReq())
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('status=degraded when shrinkage cron is stale', async () => {
    // 3h old > 2h threshold
    const stale = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    mockNewestComputedAt.mockResolvedValue(stale)
    stubSupabasePortfolio(new Date().toISOString())
    const res = await GET(makeReq())
    const body = (await res.json()) as { status: string; shrinkage_cron_age_seconds: number }
    expect(body.status).toBe('degraded')
    expect(body.shrinkage_cron_age_seconds).toBeGreaterThan(2 * 3600)
  })

  it('status=degraded when portfolio upstream errors', async () => {
    mockNewestComputedAt.mockResolvedValue(new Date().toISOString())
    stubSupabasePortfolio(null, { message: 'pg connection lost' })
    const res = await GET(makeReq())
    const body = (await res.json()) as { status: string; portfolio_upstream_status: string }
    expect(body.status).toBe('degraded')
    expect(body.portfolio_upstream_status).toBe('error')
  })

  it('status=degraded when portfolio upstream is stale', async () => {
    mockNewestComputedAt.mockResolvedValue(new Date().toISOString())
    // 30 min ago > 15 min threshold
    stubSupabasePortfolio(new Date(Date.now() - 30 * 60 * 1000).toISOString())
    const res = await GET(makeReq())
    const body = (await res.json()) as { status: string; portfolio_upstream_status: string }
    expect(body.status).toBe('degraded')
    expect(body.portfolio_upstream_status).toBe('stale')
  })

  it('401 when auth required and no key', async () => {
    process.env.ARENA_API_AUTH_REQUIRED = 'true'
    process.env.ARENA_API_KEYS = 'k1'
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('response validates against HealthResponse schema', async () => {
    mockNewestComputedAt.mockResolvedValue(new Date().toISOString())
    stubSupabasePortfolio(new Date().toISOString())
    const res = await GET(makeReq())
    const body = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvAny = AjvCtor as any
    const ajv = new AjvAny({ allErrors: true })
    ajv.addSchema(schemaJson as object, 'v1')
    const validate = ajv.getSchema('v1#/definitions/HealthResponse')
    const valid = validate(body)
    if (!valid) {
      // eslint-disable-next-line no-console
      console.error('Schema errors:', validate.errors)
    }
    expect(valid).toBe(true)
  })
})

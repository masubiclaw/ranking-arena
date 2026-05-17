/**
 * /api/top-traders legacy redirect tests.
 *
 * The endpoint moved to /api/v1/top-traders during the D5 hardening pass.
 * The legacy path stays around for one release as a 308 permanent redirect
 * that preserves the query string and advertises Deprecation/Sunset headers
 * so ACP clients can migrate without losing requests.
 */

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
    async json() {
      return this._body
    }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
    static redirect(url: URL | string, status = 307) {
      const res = new MockNextResponse(null, { status })
      res.headers.set('location', url.toString())
      return res
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

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function makeReq(qs: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost/api/top-traders${qs}`, {
    headers,
  }) as unknown as NextRequest
}

describe('GET /api/top-traders (legacy 308 redirect)', () => {
  it('redirects with 308 to /api/v1/top-traders', async () => {
    const res = await GET(makeReq(''))
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('http://localhost/api/v1/top-traders')
  })

  it('preserves the original query string', async () => {
    const qs = '?criterion=p_superforecaster&window=90D&limit=20&platforms=hyperliquid,gmx&source=snapshot'
    const res = await GET(makeReq(qs))
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(`http://localhost/api/v1/top-traders${qs}`)
  })

  it('advertises Deprecation + Sunset headers and successor Link', async () => {
    const res = await GET(makeReq('?window=7D'))
    expect(res.headers.get('Deprecation')).toBe('true')
    expect(res.headers.get('Sunset')).toBeTruthy()
    expect(res.headers.get('Link')).toBe('</api/v1/top-traders>; rel="successor-version"')
  })
})

/**
 * Compose `requireArenaAuth` + token-bucket rate limit into a single gate that
 * every `/api/v1/*` handler invokes at entry.
 */

import { NextResponse } from 'next/server'
import { requireArenaAuth } from './_auth'
import { consumeToken } from './_rate-limit'

export type GatePass = { ok: true; keyId: string }
export type GateBlock = { ok: false; response: NextResponse }
export type GateResult = GatePass | GateBlock

export function gate(request: Request): GateResult {
  const auth = requireArenaAuth(request)
  if (!auth.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: auth.error }, { status: auth.status }),
    }
  }

  const allow = consumeToken(auth.keyId)
  if (!allow.ok) {
    const res = NextResponse.json(
      { error: 'rate_limited', detail: `bucket exhausted, retry in ${allow.retryAfterSeconds}s` },
      { status: 429 },
    )
    res.headers.set('Retry-After', String(allow.retryAfterSeconds))
    res.headers.set('X-RateLimit-Limit', String(allow.limit))
    res.headers.set('X-RateLimit-Remaining', '0')
    return { ok: false, response: res }
  }

  return { ok: true, keyId: auth.keyId }
}

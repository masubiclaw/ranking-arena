/**
 * Auth gate for the v1 copy-trade API.
 *
 * Two helpers:
 *   - `requireArenaAuth(request)` — D5 hardened gate keyed on the explicit env
 *     `ARENA_API_AUTH_REQUIRED=true`. When set, every request must present a
 *     valid API key in either `X-Arena-Api-Key` or `Authorization: Bearer ...`.
 *     Returns the bucket key identifier (`api:<sha256-prefix>` for valid keys,
 *     `ip:<addr>` when auth is off) so the rate limiter can scope per caller.
 *     Valid keys come from `ARENA_API_KEYS` (comma-separated); for backward
 *     compat the existing `BOT_API_KEY` is also accepted.
 *
 *   - `checkBotAuth(request)` — legacy bearer-only helper retained so the
 *     existing `trader-portfolio` / `trader-portfolios` routes keep their
 *     "require token in prod" behaviour. New routes should use
 *     `requireArenaAuth` instead.
 */

import { createHash } from 'crypto'

export type AuthFailure = { ok: false; status: 401 | 500; error: string }
export type AuthSuccess = { ok: true; keyId: string }
export type AuthResult = AuthSuccess | AuthFailure

const X_ARENA_HEADER = 'x-arena-api-key'

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for') || ''
  const first = fwd.split(',')[0]?.trim()
  if (first) return first
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return 'unknown'
}

function extractKey(request: Request): string | null {
  const xKey = request.headers.get(X_ARENA_HEADER)
  if (xKey && xKey.trim().length > 0) return xKey.trim()
  const authz = request.headers.get('authorization') || ''
  const m = authz.match(/^Bearer\s+(.+)$/i)
  if (m) return m[1].trim()
  return null
}

function configuredKeys(): Set<string> {
  const out = new Set<string>()
  const listed = (process.env.ARENA_API_KEYS || '').split(',')
  for (const raw of listed) {
    const k = raw.trim()
    if (k.length > 0) out.add(k)
  }
  const bot = (process.env.BOT_API_KEY || '').trim()
  if (bot.length > 0) out.add(bot)
  return out
}

function keyBucketId(key: string): string {
  return `api:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export function requireArenaAuth(request: Request): AuthResult {
  const required = (process.env.ARENA_API_AUTH_REQUIRED || '').toLowerCase() === 'true'
  if (!required) {
    return { ok: true, keyId: `ip:${clientIp(request)}` }
  }

  const valid = configuredKeys()
  if (valid.size === 0) {
    return { ok: false, status: 500, error: 'auth_misconfigured' }
  }

  const presented = extractKey(request)
  if (!presented) return { ok: false, status: 401, error: 'unauthorized' }
  if (!valid.has(presented)) return { ok: false, status: 401, error: 'unauthorized' }

  return { ok: true, keyId: keyBucketId(presented) }
}

/** Legacy bearer-only helper. New routes should call `requireArenaAuth`. */
export function checkBotAuth(request: Request): { ok: true } | AuthFailure {
  const isProd = process.env.NODE_ENV === 'production'
  const configuredKey = process.env.BOT_API_KEY

  if (!configuredKey) {
    if (isProd) return { ok: false, status: 500, error: 'auth_misconfigured' }
    return { ok: true }
  }

  const header = request.headers.get('authorization') || ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, error: 'unauthorized' }
  if (m[1].trim() !== configuredKey) return { ok: false, status: 401, error: 'unauthorized' }
  return { ok: true }
}

export const __test = { keyBucketId, clientIp, configuredKeys, extractKey }

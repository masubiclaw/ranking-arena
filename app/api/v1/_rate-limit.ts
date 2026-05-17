/**
 * In-process per-key token bucket for `/api/v1/*`.
 *
 * Bucket key is whatever `requireArenaAuth` returns — `api:<sha>` when a real
 * API key is in play, `ip:<addr>` in dev/anonymous mode. Capacity is
 * `ARENA_API_RATE_LIMIT_RPM` (default 600) per minute. No Redis dependency.
 */

const DEFAULT_RPM = 600

interface Bucket {
  tokens: number
  rate: number
  capacity: number
  lastRefill: number
}

const buckets = new Map<string, Bucket>()
let cachedRpm: number | null = null

function configuredRpm(): number {
  if (cachedRpm !== null) return cachedRpm
  const raw = process.env.ARENA_API_RATE_LIMIT_RPM
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) {
      cachedRpm = Math.floor(n)
      return cachedRpm
    }
  }
  cachedRpm = DEFAULT_RPM
  return cachedRpm
}

export interface AllowResult {
  ok: boolean
  remaining: number
  limit: number
  retryAfterSeconds: number
}

export function consumeToken(
  bucketKey: string,
  now: number = Date.now() / 1000,
): AllowResult {
  const rpm = configuredRpm()
  const capacity = rpm
  const rate = rpm / 60

  let b = buckets.get(bucketKey)
  if (!b) {
    b = { tokens: capacity, rate, capacity, lastRefill: now }
    buckets.set(bucketKey, b)
  } else {
    b.rate = rate
    b.capacity = capacity
    const elapsed = Math.max(0, now - b.lastRefill)
    b.tokens = Math.min(capacity, b.tokens + elapsed * rate)
    b.lastRefill = now
  }

  if (b.tokens >= 1) {
    b.tokens -= 1
    return { ok: true, remaining: Math.floor(b.tokens), limit: capacity, retryAfterSeconds: 0 }
  }

  const deficit = 1 - b.tokens
  const retry = Math.max(1, Math.ceil(deficit / rate))
  return { ok: false, remaining: 0, limit: capacity, retryAfterSeconds: retry }
}

export const __test = {
  reset(): void {
    buckets.clear()
    cachedRpm = null
  },
  size(): number {
    return buckets.size
  },
}

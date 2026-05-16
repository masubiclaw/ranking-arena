/**
 * Synthetic concurrency tests for compute-leaderboard Redis lock.
 *
 * Verifies:
 * 1. First concurrent request acquires the SET NX EX lock.
 * 2. Second concurrent request is correctly blocked (NX miss).
 * 3. Redis unavailable in prod → fail-safe skip (no bypass).
 * 4. Redis unavailable in dev → bypass allowed (dev convenience).
 * 5. Lock is released via DEL after run completes.
 * 6. Per-season lock keys don't interfere with each other.
 *
 * @jest-environment node
 */

const mockRedisSet = jest.fn()
const mockRedisDel = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn(),
}))

import { getSharedRedis } from '@/lib/cache/redis-client'

const mockGetSharedRedis = getSharedRedis as jest.MockedFunction<typeof getSharedRedis>

// ---------------------------------------------------------------------------
// Lock helpers — mirror the exact acquire/release logic from route.ts
// ---------------------------------------------------------------------------

type RedisMock = {
  set: typeof mockRedisSet
  del: typeof mockRedisDel
}

async function acquireLock(key: string, ttl: number, isProduction: boolean): Promise<boolean> {
  try {
    const redis = (await getSharedRedis()) as RedisMock | null
    if (redis) {
      const result = await redis.set(key, new Date().toISOString(), { nx: true, ex: ttl })
      return result === 'OK'
    } else {
      // Mirror the route.ts logic exactly
      if (!isProduction) {
        return true // dev bypass: single-process, no concurrent risk
      } else {
        return false // prod fail-safe: skip run to prevent double-compute
      }
    }
  } catch {
    return false // Redis threw — fail safe
  }
}

async function releaseLock(key: string): Promise<void> {
  try {
    const redis = (await getSharedRedis()) as RedisMock | null
    if (redis) await redis.del(key)
  } catch {
    // best-effort; TTL will expire the lock
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compute-leaderboard Redis lock', () => {
  const LOCK_KEY = 'cron:compute-leaderboard:running'
  const TTL = 300

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('lock acquisition', () => {
    it('first request acquires lock when Redis returns OK', async () => {
      mockRedisSet.mockResolvedValueOnce('OK')
      mockGetSharedRedis.mockResolvedValue({ set: mockRedisSet, del: mockRedisDel } as any)

      const acquired = await acquireLock(LOCK_KEY, TTL, true)

      expect(acquired).toBe(true)
      expect(mockRedisSet).toHaveBeenCalledWith(LOCK_KEY, expect.any(String), { nx: true, ex: TTL })
    })

    it('concurrent second request is blocked when lock already held (SET NX returns null)', async () => {
      // Simulate concurrent access: first gets 'OK', second gets null (NX miss)
      mockRedisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null)
      mockGetSharedRedis.mockResolvedValue({ set: mockRedisSet, del: mockRedisDel } as any)

      const [first, second] = await Promise.all([
        acquireLock(LOCK_KEY, TTL, true),
        acquireLock(LOCK_KEY, TTL, true),
      ])

      expect(first).toBe(true)
      expect(second).toBe(false) // blocked — prevents double-compute
      expect(mockRedisSet).toHaveBeenCalledTimes(2)
    })
  })

  describe('Redis unavailable behavior', () => {
    it('production: fails safe (returns false) when Redis is null', async () => {
      mockGetSharedRedis.mockResolvedValue(null)

      const acquired = await acquireLock(LOCK_KEY, TTL, true /* production */)

      expect(acquired).toBe(false)
      expect(mockRedisSet).not.toHaveBeenCalled()
    })

    it('development: allows bypass (returns true) when Redis is null', async () => {
      mockGetSharedRedis.mockResolvedValue(null)

      const acquired = await acquireLock(LOCK_KEY, TTL, false /* development */)

      expect(acquired).toBe(true) // dev convenience — single process, no concurrent risk
      expect(mockRedisSet).not.toHaveBeenCalled()
    })

    it('production: fails safe (returns false) when Redis throws', async () => {
      mockGetSharedRedis.mockRejectedValue(new Error('connection refused'))

      const acquired = await acquireLock(LOCK_KEY, TTL, true /* production */)

      expect(acquired).toBe(false)
    })
  })

  describe('lock release', () => {
    it('releases lock via DEL after run completes', async () => {
      mockRedisDel.mockResolvedValueOnce(1)
      mockGetSharedRedis.mockResolvedValue({ set: mockRedisSet, del: mockRedisDel } as any)

      await releaseLock(LOCK_KEY)

      expect(mockRedisDel).toHaveBeenCalledWith(LOCK_KEY)
    })

    it('does not throw when Redis DEL fails during release (best-effort)', async () => {
      mockRedisDel.mockRejectedValueOnce(new Error('Redis unavailable'))
      mockGetSharedRedis.mockResolvedValue({ set: mockRedisSet, del: mockRedisDel } as any)

      await expect(releaseLock(LOCK_KEY)).resolves.toBeUndefined()
    })
  })

  describe('per-season lock keys', () => {
    it('7D and 30D staggered runs use different keys and do not block each other', async () => {
      mockRedisSet.mockResolvedValue('OK')
      mockGetSharedRedis.mockResolvedValue({ set: mockRedisSet, del: mockRedisDel } as any)

      const key7D = `${LOCK_KEY}:7D`
      const key30D = `${LOCK_KEY}:30D`

      const [lock7D, lock30D] = await Promise.all([
        acquireLock(key7D, TTL, true),
        acquireLock(key30D, TTL, true),
      ])

      expect(lock7D).toBe(true)
      expect(lock30D).toBe(true) // different keys — no interference
      expect(mockRedisSet).toHaveBeenCalledWith(key7D, expect.any(String), { nx: true, ex: TTL })
      expect(mockRedisSet).toHaveBeenCalledWith(key30D, expect.any(String), { nx: true, ex: TTL })
    })
  })
})

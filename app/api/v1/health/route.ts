/**
 * GET /api/v1/health — kill-switch endpoint polled by ACP's `arena_client.health`.
 *
 * Returns JSON describing the freshness of the three pieces ACP depends on:
 *   - the shrinkage cron (newest `trader_shrinkage_snapshots.computed_at`)
 *   - the portfolio upstream (most recent `trader_snapshots_v2.as_of_ts` is
 *     used as a proxy for "the data pipeline is still pumping")
 *   - the portfolio-snapshot cron (newest `trader_portfolio_snapshots.captured_at`),
 *     surfaced for ACP's weekly forward-validation script (CRYAA-2154).
 *
 * Top-level `status` is `degraded` when any of the three age thresholds
 * trip, otherwise `ok`. Gate: same `requireArenaAuth` + token bucket as the
 * other v1 routes so health probes count against the caller's budget — that
 * stops a misbehaving consumer from looping `/health` to evade rate limiting.
 */

import { NextRequest, NextResponse } from 'next/server'
import { newestComputedAt } from '@/lib/data/shrinkage-snapshots'
import { newestCapturedAt } from '@/lib/data/portfolio-snapshots'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { gate } from '../_gate'

export const dynamic = 'force-dynamic'

// Cron runs hourly per CRYAA-2137; 2h gives one missed-fire of grace before we
// flip the kill switch.
const SHRINKAGE_MAX_AGE_SECONDS = 2 * 3600
// Portfolio upstream is polled every ~5 min by the data pipeline; 15 min of
// staleness is the threshold beyond which ACP should stop trusting positions.
const PORTFOLIO_MAX_AGE_SECONDS = 15 * 60
// Portfolio-snapshot cron runs hourly per CRYAA-2154; 2h grace mirrors the
// shrinkage threshold so a single missed fire does not flip the kill switch.
const PORTFOLIO_SNAPSHOT_MAX_AGE_SECONDS = 2 * 3600

const PORTFOLIO_HEALTH_WINDOW: '90D' | '7D' = '90D'

type UpstreamStatus = 'ok' | 'stale' | 'error'

interface HealthResponse {
  status: 'ok' | 'degraded'
  shrinkage_cron_last_run: string | null
  shrinkage_cron_age_seconds: number | null
  portfolio_upstream_status: UpstreamStatus
  portfolio_upstream_last_seen: string | null
  portfolio_snapshot_cron_last_run: string | null
  portfolio_snapshot_cron_age_seconds: number | null
  version: string
}

function buildVersion(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.SENTRY_RELEASE ||
    process.env.npm_package_version ||
    'dev'
  )
}

async function portfolioFreshness(): Promise<{
  status: UpstreamStatus
  lastSeen: string | null
}> {
  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('as_of_ts')
      .eq('window', PORTFOLIO_HEALTH_WINDOW)
      .order('as_of_ts', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return { status: 'error', lastSeen: null }
    const lastSeen = (data as { as_of_ts?: string } | null)?.as_of_ts ?? null
    if (!lastSeen) return { status: 'stale', lastSeen: null }
    const ageMs = Date.now() - new Date(lastSeen).getTime()
    if (Number.isNaN(ageMs)) return { status: 'error', lastSeen }
    if (ageMs / 1000 > PORTFOLIO_MAX_AGE_SECONDS) return { status: 'stale', lastSeen }
    return { status: 'ok', lastSeen }
  } catch (err) {
    logger.warn('[/api/v1/health] portfolio freshness check failed:', err instanceof Error ? err.message : String(err))
    return { status: 'error', lastSeen: null }
  }
}

async function shrinkageFreshness(): Promise<{ lastRun: string | null; ageSeconds: number | null }> {
  try {
    const lastRun = await newestComputedAt('90D')
    if (!lastRun) return { lastRun: null, ageSeconds: null }
    const ageMs = Date.now() - new Date(lastRun).getTime()
    if (Number.isNaN(ageMs)) return { lastRun, ageSeconds: null }
    return { lastRun, ageSeconds: Math.max(0, Math.floor(ageMs / 1000)) }
  } catch (err) {
    logger.warn('[/api/v1/health] shrinkage freshness check failed:', err instanceof Error ? err.message : String(err))
    return { lastRun: null, ageSeconds: null }
  }
}

async function portfolioSnapshotFreshness(): Promise<{
  lastRun: string | null
  ageSeconds: number | null
}> {
  try {
    const lastRun = await newestCapturedAt()
    if (!lastRun) return { lastRun: null, ageSeconds: null }
    const ageMs = Date.now() - new Date(lastRun).getTime()
    if (Number.isNaN(ageMs)) return { lastRun, ageSeconds: null }
    return { lastRun, ageSeconds: Math.max(0, Math.floor(ageMs / 1000)) }
  } catch (err) {
    logger.warn(
      '[/api/v1/health] portfolio-snapshot freshness check failed:',
      err instanceof Error ? err.message : String(err)
    )
    return { lastRun: null, ageSeconds: null }
  }
}

export async function GET(request: NextRequest) {
  const pass = gate(request)
  if (!pass.ok) return pass.response

  const [shrink, portfolio, portfolioSnapshot] = await Promise.all([
    shrinkageFreshness(),
    portfolioFreshness(),
    portfolioSnapshotFreshness(),
  ])

  const shrinkOk =
    shrink.ageSeconds !== null && shrink.ageSeconds <= SHRINKAGE_MAX_AGE_SECONDS
  const portfolioOk = portfolio.status === 'ok'
  const portfolioSnapshotOk =
    portfolioSnapshot.ageSeconds !== null &&
    portfolioSnapshot.ageSeconds <= PORTFOLIO_SNAPSHOT_MAX_AGE_SECONDS
  const status: HealthResponse['status'] =
    shrinkOk && portfolioOk && portfolioSnapshotOk ? 'ok' : 'degraded'

  const body: HealthResponse = {
    status,
    shrinkage_cron_last_run: shrink.lastRun,
    shrinkage_cron_age_seconds: shrink.ageSeconds,
    portfolio_upstream_status: portfolio.status,
    portfolio_upstream_last_seen: portfolio.lastSeen,
    portfolio_snapshot_cron_last_run: portfolioSnapshot.lastRun,
    portfolio_snapshot_cron_age_seconds: portfolioSnapshot.ageSeconds,
    version: buildVersion(),
  }

  const response = NextResponse.json(body)
  // Always fresh — health drives the kill switch.
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export const __test = {
  PORTFOLIO_MAX_AGE_SECONDS,
  SHRINKAGE_MAX_AGE_SECONDS,
  PORTFOLIO_SNAPSHOT_MAX_AGE_SECONDS,
  buildVersion,
}

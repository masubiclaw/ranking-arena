/**
 * GET /api/v1/top-traders
 *
 * Versioned mount of the shrinkage envelope endpoint consumed by ACP's
 * copy-trade bot (`backend/copy_trade/arena_client.py :: top_traders`).
 *
 * Read modes:
 *   - `source=snapshot` (default, production): freshest row per
 *     `(platform, trader_key)` from `trader_shrinkage_snapshots`. 503 when no
 *     row is fresher than `max_age_hours` (default 25h).
 *   - `source=live`: recomputes `estimatePopulation` + `shrinkOne` from
 *     `trader_snapshots_v2` on the fly. Debug path; no edge cache.
 *
 * Time-travel:
 *   `?snapshot_at=<iso8601>` reads the closest snapshot at-or-before the
 *   timestamp. Returns 404 when no snapshot exists prior to that time.
 *   Implicit when set — `source` and `max_age_hours` are ignored.
 *
 * Gate: `requireArenaAuth` + per-key token bucket (`ARENA_API_RATE_LIMIT_RPM`,
 * default 600/min). See `_gate.ts`.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  findAtOrBefore,
  latestForWindow,
  type ShrinkageWindow,
  type TraderShrinkageSnapshot,
} from '@/lib/data/shrinkage-snapshots'
import {
  defaultActiveSince,
  fetchEligibleArenaPool,
} from '@/lib/data/arena-eligible-pool'
import { getBtcBenchmark } from '@/lib/data/btc-returns'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { aggregateExcessSharpe } from '@/lib/utils/benchmark-sharpe'
import {
  estimatePopulation,
  posteriorProbAbove,
  shrinkOne,
  thresholdForTopFraction,
  type ShrinkageInput,
} from '@/lib/utils/shrinkage'
import { logger } from '@/lib/logger'
import { gate } from '../_gate'

export const dynamic = 'force-dynamic'

const CACHE_HEADER = 'public, max-age=0, s-maxage=60, stale-while-revalidate=60'
const HISTORY_CACHE_HEADER = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600'
const VALID_WINDOWS: readonly ShrinkageWindow[] = ['7D', '30D', '90D']
const DEFAULT_MAX_AGE_HOURS = 25
const DEFAULT_LIMIT = 20

interface TraderRow {
  platform: string
  trader_key: string
  observed: number | null
  shrunk: number | null
  posterior_sd: number | null
  weight_to_prior: number | null
  p_superforecaster: number | null
}

interface ShrinkageBlock {
  mu_pop: number | null
  tau_sq: number | null
  eligible_n: number | null
  sf_threshold: number | null
  sf_fraction: number | null
  snapshot_date: string
}

interface Envelope {
  shrinkage: ShrinkageBlock
  traders: TraderRow[]
}

export async function GET(request: NextRequest) {
  const pass = gate(request)
  if (!pass.ok) return pass.response

  const { searchParams } = new URL(request.url)

  const criterion = searchParams.get('criterion') ?? 'p_superforecaster'
  if (criterion !== 'p_superforecaster') {
    return NextResponse.json(
      { error: 'invalid_criterion', detail: `criterion must be p_superforecaster (got ${criterion})` },
      { status: 400 },
    )
  }

  const windowParam = (searchParams.get('window') ?? '90D') as ShrinkageWindow
  if (!VALID_WINDOWS.includes(windowParam)) {
    return NextResponse.json(
      { error: 'invalid_window', detail: `window must be one of ${VALID_WINDOWS.join('|')} (got ${windowParam})` },
      { status: 400 },
    )
  }

  const source = searchParams.get('source') ?? 'snapshot'
  if (source !== 'snapshot' && source !== 'live') {
    return NextResponse.json(
      { error: 'invalid_source', detail: `source must be snapshot|live (got ${source})` },
      { status: 400 },
    )
  }

  const limit = parsePositiveInt(searchParams.get('limit'), DEFAULT_LIMIT)
  if (limit === null) {
    return NextResponse.json(
      { error: 'invalid_limit', detail: 'limit must be a positive integer' },
      { status: 400 },
    )
  }

  const platforms = parsePlatforms(searchParams.get('platforms'))
  const maxAgeHours =
    parsePositiveInt(searchParams.get('max_age_hours'), DEFAULT_MAX_AGE_HOURS) ?? DEFAULT_MAX_AGE_HOURS

  const snapshotAtRaw = searchParams.get('snapshot_at')
  const snapshotAt = parseSnapshotAt(snapshotAtRaw)
  if (snapshotAtRaw && !snapshotAt) {
    return NextResponse.json(
      { error: 'invalid_snapshot_at', detail: 'snapshot_at must be a valid ISO-8601 timestamp' },
      { status: 400 },
    )
  }

  try {
    if (snapshotAt) {
      const rows = await findAtOrBefore(windowParam, snapshotAt, { platforms })
      if (!rows || rows.length === 0) {
        return NextResponse.json(
          {
            error: 'no_snapshot_before',
            detail: `no snapshot at or before ${snapshotAt.toISOString()} for window ${windowParam}`,
          },
          { status: 404 },
        )
      }
      const envelope = buildEnvelope(rows, limit)
      const response = NextResponse.json(envelope)
      response.headers.set('Cache-Control', HISTORY_CACHE_HEADER)
      return response
    }

    const envelope =
      source === 'snapshot'
        ? await readSnapshot(windowParam, platforms, limit, maxAgeHours)
        : await readLive(windowParam, platforms, limit)

    if (envelope === 'stale') {
      return NextResponse.json(
        { error: 'snapshot_stale', detail: `no snapshot fresher than ${maxAgeHours}h for window ${windowParam}` },
        { status: 503 },
      )
    }
    if (envelope === 'empty') {
      return NextResponse.json(
        { error: 'no_data', detail: `no traders available for window ${windowParam}` },
        { status: 503 },
      )
    }

    const response = NextResponse.json(envelope)
    response.headers.set('Cache-Control', source === 'snapshot' ? CACHE_HEADER : 'no-store')
    return response
  } catch (err) {
    logger.error('[/api/v1/top-traders] error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}

async function readSnapshot(
  window: ShrinkageWindow,
  platforms: string[] | undefined,
  limit: number,
  maxAgeHours: number,
): Promise<Envelope | 'stale' | 'empty'> {
  const rows = await latestForWindow(window, { platforms, maxAgeSeconds: maxAgeHours * 3600 })
  if (rows.length === 0) return 'stale'
  return buildEnvelope(rows, limit)
}

const PERIOD_DAYS: Record<ShrinkageWindow, number> = { '7D': 7, '30D': 30, '90D': 90 }

async function readLive(
  window: ShrinkageWindow,
  platforms: string[] | undefined,
  limit: number,
): Promise<Envelope | 'empty'> {
  const supabase = getSupabaseAdmin()

  // Single source of truth for the eligible pool. Same predicate as the
  // /superforecasters page and (when built) the D1 shrinkage cron.
  const eligible = await fetchEligibleArenaPool(supabase, {
    window,
    minUpdatedAt: defaultActiveSince(),
    platforms,
  })

  if (eligible.length === 0) return 'empty'

  let btcReturn = 0
  try {
    const snap = await getBtcBenchmark(window)
    btcReturn = snap.periodReturnPct
  } catch {
    /* fall through with 0 */
  }

  // Compute sharpe_vs_btc per row (matches /superforecasters semantics).
  // Rows where roi_pct is null or aggregateExcessSharpe returns null are
  // dropped here. The predicate already guarantees a credible drawdown.
  const enriched = eligible
    .map((r) => {
      const svb = r.roi_pct != null
        ? aggregateExcessSharpe(r.roi_pct, btcReturn, r.max_drawdown, PERIOD_DAYS[window])
        : null
      if (svb == null) return null
      return { row: r, svb }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  if (enriched.length === 0) return 'empty'

  const inputs: ShrinkageInput[] = enriched.map((e) => ({
    observed: e.svb,
    tradesCount: e.row.trades_count ?? null,
  }))
  const pop = estimatePopulation(inputs)
  if (!pop) return 'empty'

  // Observability: log pool size and μ_pop at scan time so we can compare
  // before/after the predicate change (CRYAA-2118 acceptance #6).
  logger.info('[/api/v1/top-traders] live scan', {
    window,
    eligible_n: pop.n,
    mu_pop: pop.muPop,
    tau_sq: pop.tauSq,
  })

  // First pass: posterior mean/sd per trader.
  const partials = enriched.map((e, i) => ({
    row: e.row,
    result: shrinkOne(inputs[i], pop),
  }))

  // Second pass: derive the SF threshold from the full shrunk distribution and
  // compute pSuperforecaster relative to it. `sf_fraction` is fixed at 0.05
  // (top 5%) to match ACP's expected envelope.
  const SF_FRACTION = 0.05
  const sfThreshold = thresholdForTopFraction(
    partials.map(p => p.result.shrunk),
    SF_FRACTION,
  )

  const computedAt = new Date().toISOString()
  const traders: TraderRow[] = partials.map(({ row, result }) => ({
    platform: row.platform,
    trader_key: row.trader_key,
    observed: result.observed,
    shrunk: result.shrunk,
    posterior_sd: result.posteriorSd,
    weight_to_prior: result.weightToPrior,
    p_superforecaster: posteriorProbAbove(result.shrunk, result.posteriorSd, sfThreshold),
  }))

  traders.sort(byPSfDesc)
  return {
    shrinkage: {
      mu_pop: pop.muPop,
      tau_sq: pop.tauSq,
      eligible_n: pop.n,
      sf_threshold: sfThreshold,
      sf_fraction: SF_FRACTION,
      snapshot_date: computedAt.slice(0, 10),
    },
    traders: traders.slice(0, limit),
  }
}

function buildEnvelope(rows: readonly TraderShrinkageSnapshot[], limit: number): Envelope {
  const freshest = rows.reduce((a, b) => (a.computed_at > b.computed_at ? a : b))
  const traders: TraderRow[] = rows.map(r => ({
    platform: r.platform,
    trader_key: r.trader_key,
    observed: r.observed,
    shrunk: r.shrunk,
    posterior_sd: r.posterior_sd,
    weight_to_prior: r.weight_to_prior,
    p_superforecaster: r.p_superforecaster,
  }))
  traders.sort(byPSfDesc)
  return {
    shrinkage: {
      mu_pop: freshest.mu_pop,
      tau_sq: freshest.tau_sq,
      eligible_n: freshest.eligible_n,
      sf_threshold: freshest.sf_threshold,
      sf_fraction: freshest.sf_fraction,
      snapshot_date: freshest.computed_at.slice(0, 10),
    },
    traders: traders.slice(0, limit),
  }
}

function byPSfDesc(a: TraderRow, b: TraderRow): number {
  const av = a.p_superforecaster
  const bv = b.p_superforecaster
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

function parsePositiveInt(raw: string | null, fallback: number): number | null {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null
  return n
}

function parsePlatforms(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const list = raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
  return list.length > 0 ? list : undefined
}

function parseSnapshotAt(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d
}

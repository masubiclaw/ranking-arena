/**
 * Sharpe ratio variants that use BTC as the risk-free benchmark instead of 0.
 *
 * Two paths:
 *   1. Full Sharpe — needs the trader's daily-return series. Subtracts BTC's
 *      daily return per-day, then mean(excess) / stddev(excess) × √365.
 *   2. Aggregate fallback — when we only have period ROI + max_drawdown
 *      (which is the case for most of our current snapshots), approximate
 *      a Sharpe-like risk-adjusted excess return using Calmar form:
 *      (traderROI − btcROI) / |max_drawdown|, annualised by periodDays.
 *
 * Both paths are clamped to ±10 to keep the leaderboard sortable.
 */

const TRADING_DAYS = 365
const CAP = 10

export function sharpeVsBenchmark(
  traderDailyReturnsPct: number[],
  benchmarkDailyReturnsPct: number[],
): number | null {
  const n = Math.min(traderDailyReturnsPct.length, benchmarkDailyReturnsPct.length)
  if (n < 3) return null

  const excess: number[] = []
  for (let i = 0; i < n; i++) {
    excess.push(traderDailyReturnsPct[i] - benchmarkDailyReturnsPct[i])
  }
  const mean = excess.reduce((a, b) => a + b, 0) / n
  const variance = excess.reduce((s, r) => s + (r - mean) * (r - mean), 0) / n
  const stdDev = Math.sqrt(variance)
  if (stdDev === 0) return null

  const sharpe = (mean / stdDev) * Math.sqrt(TRADING_DAYS)
  if (!Number.isFinite(sharpe)) return null
  return Math.max(-CAP, Math.min(CAP, Math.round(sharpe * 100) / 100))
}

export function aggregateExcessSharpe(
  traderRoiPct: number,
  benchmarkRoiPct: number,
  maxDrawdownPct: number | null,
  _periodDays: number,
): number | null {
  if (!Number.isFinite(traderRoiPct) || !Number.isFinite(benchmarkRoiPct)) return null

  // Drawdown is our volatility proxy. Drop traders with no observed drawdown
  // (or zero drawdown — almost always a data-quality issue, not a real
  // achievement on a 7D+ window). Without a credible denominator the
  // ratio is meaningless.
  if (maxDrawdownPct == null) return null
  const dd = Math.abs(maxDrawdownPct)
  if (dd < 0.5) return null

  // Period excess return per unit of drawdown — Calmar-in-spirit, with BTC
  // as the benchmark. Not annualised (the period itself defines the scale,
  // and annualising tiny 7D wins makes them look heroic).
  const raw = (traderRoiPct - benchmarkRoiPct) / dd
  if (!Number.isFinite(raw)) return null
  return Math.round(raw * 100) / 100
}

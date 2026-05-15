/**
 * Empirical Bayes shrinkage for sharpe-vs-BTC and similar noisy per-trader
 * metrics.
 *
 * Model:
 *   observed_i  =  θ_i  +  ε_i        ε_i ~ N(0, σ_i²)
 *   θ_i         ~  N(μ_pop, τ²_pop)
 *
 * Posterior mean (shrunk estimate):
 *   θ̂_i = w_i · μ_pop + (1 − w_i) · observed_i      w_i = σ_i² / (σ_i² + τ²_pop)
 *
 * Per-trader noise σ_i² is approximated as `baseline / sqrt(trades_count)` —
 * traders with more trades have more precise estimates. When `trades_count`
 * is missing we substitute the population median so the shrinkage is at least
 * defensible.
 */

export interface ShrinkageInput {
  observed: number
  tradesCount: number | null
}

export interface ShrinkageOutput {
  observed: number
  shrunk: number
  posteriorSd: number
  weightToPrior: number   // w_i  — 0 means "trust the data fully", 1 means "fully shrunk to mean"
}

export interface ShrinkagePopulationParams {
  muPop: number
  tauSq: number
  meanSigmaSq: number
  baseline: number
  medianTrades: number
  n: number
}

/**
 * Estimate population parameters from a batch of observations.
 * Returns `null` if the batch is too small for a credible variance estimate.
 */
// Sanity cap for raw sharpe_vs_btc. Anything above this is almost always a
// small-account-with-tiny-drawdown artifact, not a real edge. Applied
// symmetrically so leveraged blow-ups don't blow out τ² either.
const RAW_CAP = 30

function capObservation(x: number): number {
  return Math.max(-RAW_CAP, Math.min(RAW_CAP, x))
}

export function estimatePopulation(observations: ShrinkageInput[]): ShrinkagePopulationParams | null {
  // Cap before fitting — keeps the prior representative of typical traders.
  const xs = observations.map((o) => capObservation(o.observed))
  const n = xs.length
  if (n < 5) return null

  // Robustify further against extreme outliers by computing μ_pop and var on
  // a trimmed core (5th–95th percentiles).
  const sorted = [...xs].sort((a, b) => a - b)
  const loIdx = Math.floor(n * 0.05)
  const hiIdx = Math.max(loIdx + 1, Math.ceil(n * 0.95))
  const core = sorted.slice(loIdx, hiIdx)
  const coreN = core.length
  const muPop = core.reduce((a, b) => a + b, 0) / coreN
  const varObs = core.reduce((s, x) => s + (x - muPop) ** 2, 0) / Math.max(coreN - 1, 1)

  const tradeSamples = observations
    .map((o) => o.tradesCount)
    .filter((t): t is number => t != null && t > 0)
    .sort((a, b) => a - b)
  const medianTrades = tradeSamples.length > 0
    ? tradeSamples[Math.floor(tradeSamples.length / 2)]
    : 30

  // Calibrate baseline so the median trader has σ² ≈ var_obs / 3 — a moderate
  // noise floor that leaves room for τ² to capture the rest as signal.
  const baseline = (varObs / 3) * Math.sqrt(medianTrades)

  const sigmaSqs = observations.map((o) => {
    const tc = o.tradesCount && o.tradesCount > 0 ? o.tradesCount : medianTrades
    return baseline / Math.sqrt(tc)
  })
  const meanSigmaSq = sigmaSqs.reduce((a, b) => a + b, 0) / n

  // τ² = max(var_obs − mean σ², floor) — floor at 5% of var_obs so we never
  // collapse to "all observations are noise."
  const tauSq = Math.max(varObs - meanSigmaSq, varObs * 0.05)

  return { muPop, tauSq, meanSigmaSq, baseline, medianTrades, n }
}

export function shrinkOne(input: ShrinkageInput, params: ShrinkagePopulationParams): ShrinkageOutput {
  const tc = input.tradesCount && input.tradesCount > 0 ? input.tradesCount : params.medianTrades
  const sigmaSq = params.baseline / Math.sqrt(tc)
  const weightToPrior = sigmaSq / (sigmaSq + params.tauSq)
  // Cap raw observation so a single extreme outlier doesn't beat steadier
  // top performers just by survival. Raw value is still surfaced separately.
  const cappedObserved = capObservation(input.observed)
  const shrunk = weightToPrior * params.muPop + (1 - weightToPrior) * cappedObserved
  // Posterior variance: harmonic combination of prior and likelihood precisions.
  const posteriorVar = 1 / (1 / params.tauSq + 1 / sigmaSq)
  return {
    observed: input.observed,
    shrunk: round(shrunk, 3),
    posteriorSd: round(Math.sqrt(posteriorVar), 3),
    weightToPrior: round(weightToPrior, 3),
  }
}

/**
 * Posterior probability P(θ_i > threshold | data) under the Gaussian model.
 * Uses the cumulative distribution of N(shrunk, posteriorSd²).
 */
export function posteriorProbAbove(shrunk: number, posteriorSd: number, threshold: number): number {
  if (posteriorSd <= 0) return shrunk > threshold ? 1 : 0
  // 1 - Φ((threshold - μ) / σ)
  const z = (threshold - shrunk) / posteriorSd
  return round(1 - normCdf(z), 4)
}

/**
 * Pick a threshold that calibrates "superforecaster" to a target population
 * fraction (default 5%). Returns the score above which `fraction` of the
 * shrunk distribution sits.
 */
export function thresholdForTopFraction(shrunks: number[], fraction: number = 0.05): number {
  if (shrunks.length === 0) return 0
  const sorted = [...shrunks].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - fraction)))
  return sorted[idx]
}

function round(x: number, decimals: number): number {
  const m = 10 ** decimals
  return Math.round(x * m) / m
}

/** Standard normal CDF using the Abramowitz–Stegun approximation. */
function normCdf(z: number): number {
  // |z| > 8 the tail is effectively 0 / 1
  if (z > 8) return 1
  if (z < -8) return 0
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp(-z * z / 2)
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}

/**
 * Cross-platform shape for a trader's open positions.
 *
 * Every position connector normalizes to this. Lets the dashboard, change
 * detector, and copy executor speak one language regardless of source.
 */

export interface Position {
  /** Display ticker, e.g. "BTC" or "ETH-PERP". */
  symbol: string
  /** "long" | "short". Derived from signed size in source data. */
  side: 'long' | 'short'
  /** Absolute size in base units (e.g. 0.42 BTC). */
  size: number
  /** Entry price in quote (usually USD). */
  entryPrice: number
  /** Mark / index price the platform last reported, if available. */
  markPrice?: number
  /** Effective leverage. Some platforms only expose initial leverage. */
  leverage?: number
  /** Notional value of the position in USD (`size × markPrice`). */
  notionalUsd: number
  /** Unrealized PnL in USD. */
  unrealizedPnlUsd?: number
  /** Liquidation price if reported. */
  liqPrice?: number
}

export interface TraderPortfolio {
  platform: string
  traderKey: string
  accountValueUsd?: number
  totalNotionalUsd: number
  positions: Position[]
  fetchedAt: string
  /** Free-text source label, for debugging. */
  source: string
}

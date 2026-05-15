/**
 * Cross-platform position dispatcher. Routes a (platform, traderKey) to the
 * right adapter and returns a `TraderPortfolio` (or null if unsupported / error).
 */

import { fetchHyperliquidPortfolio } from '../hyperliquid-portfolio'
import { fetchGmxPortfolio } from './gmx'
import { fetchDydxPortfolio } from './dydx'
import type { TraderPortfolio, Position } from './types'

export type { Position, TraderPortfolio }

export async function fetchPortfolio(
  platform: string,
  traderKey: string,
): Promise<TraderPortfolio | null> {
  switch (platform) {
    case 'hyperliquid': {
      const hl = await fetchHyperliquidPortfolio(traderKey)
      if (!hl) return null
      return {
        platform: 'hyperliquid',
        traderKey,
        accountValueUsd: hl.accountValueUsd,
        totalNotionalUsd: hl.totalNotionalUsd,
        positions: hl.positions.map((p) => ({
          symbol: p.coin,
          side: p.szi > 0 ? 'long' : 'short',
          size: Math.abs(p.szi),
          entryPrice: p.entryPx,
          leverage: p.leverage > 0 ? p.leverage : undefined,
          notionalUsd: p.positionValueUsd,
          unrealizedPnlUsd: p.unrealizedPnl,
        })),
        fetchedAt: hl.fetchedAt,
        source: 'hyperliquid-info',
      }
    }
    case 'gmx':
      return fetchGmxPortfolio(traderKey)
    case 'dydx':
      return fetchDydxPortfolio(traderKey)
    default:
      return null
  }
}

export const SUPPORTED_POSITION_PLATFORMS = new Set(['hyperliquid', 'gmx', 'dydx'])

/**
 * dYdX v4 position reader (Cosmos chain via indexer).
 *
 * The public indexer exposes `/v4/addresses/:address` → subaccount list, then
 * `/v4/perpetualPositions?address=&subaccountNumber=` returns the open
 * positions on that subaccount. We aggregate across subaccounts since most
 * top traders run subaccount 0 but a few split risk.
 */

import type { TraderPortfolio, Position } from './types'

const INDEXER = 'https://indexer.dydx.trade/v4'

interface DydxPerpPosition {
  market: string                // e.g. "BTC-USD"
  status: 'OPEN' | 'CLOSED'
  side: 'LONG' | 'SHORT'
  size: string                   // signed string
  maxSize?: string
  entryPrice: string
  exitPrice?: string | null
  realizedPnl?: string
  unrealizedPnl?: string
  netFunding?: string
  sumOpen?: string
  sumClose?: string
}

interface DydxSubaccount {
  address: string
  subaccountNumber: number
  equity: string
  freeCollateral: string
  openPerpetualPositions?: Record<string, DydxPerpPosition>
}

export async function fetchDydxPortfolio(address: string): Promise<TraderPortfolio | null> {
  // 1) Get all subaccounts for the address.
  let subaccounts: DydxSubaccount[] = []
  try {
    const res = await fetch(`${INDEXER}/addresses/${address}`)
    if (!res.ok) return null
    const json = (await res.json()) as { subaccounts?: DydxSubaccount[] }
    subaccounts = json.subaccounts ?? []
  } catch {
    return null
  }

  if (subaccounts.length === 0) {
    return {
      platform: 'dydx',
      traderKey: address,
      accountValueUsd: 0,
      totalNotionalUsd: 0,
      positions: [],
      fetchedAt: new Date().toISOString(),
      source: 'dydx-indexer',
    }
  }

  const positions: Position[] = []
  let accountValue = 0

  for (const sub of subaccounts) {
    accountValue += Number(sub.equity || 0)
    const map = sub.openPerpetualPositions ?? {}
    for (const p of Object.values(map)) {
      if (p.status !== 'OPEN') continue
      const sizeRaw = Number(p.size || 0)
      const size = Math.abs(sizeRaw)
      if (size === 0) continue
      const entry = Number(p.entryPrice || 0)
      const notional = size * entry
      positions.push({
        symbol: p.market.replace('-USD', ''),
        side: p.side === 'LONG' ? 'long' : 'short',
        size,
        entryPrice: entry,
        notionalUsd: notional,
        unrealizedPnlUsd: p.unrealizedPnl != null ? Number(p.unrealizedPnl) : undefined,
      })
    }
  }

  positions.sort((a, b) => b.notionalUsd - a.notionalUsd)
  const totalNotional = positions.reduce((s, p) => s + p.notionalUsd, 0)

  return {
    platform: 'dydx',
    traderKey: address,
    accountValueUsd: accountValue,
    totalNotionalUsd: totalNotional,
    positions,
    fetchedAt: new Date().toISOString(),
    source: 'dydx-indexer',
  }
}

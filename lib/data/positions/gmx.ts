/**
 * GMX position reader (Arbitrum).
 *
 * Uses the Squids subgraph that the GMX connector already targets. We pull
 * the trader's open positions plus their last mark price so we can compute
 * notional. Returns `null` on any network/parse failure rather than throwing.
 */

import type { TraderPortfolio, Position } from './types'

const SUBGRAPH = 'https://gmx.squids.live/gmx-synthetics-arbitrum/graphql'

// GMX represents most numbers as 1e30-scaled BigInts in strings.
const E30 = 1e30
const E18 = 1e18
const E6 = 1e6
const decimalsByToken: Record<string, number> = {
  // Common GMX-v2 indexed tokens; expand as needed.
  BTC: 8,
  WBTC: 8,
  ETH: 18,
  WETH: 18,
  ARB: 18,
  SOL: 9,
  USDC: 6,
  USDT: 6,
  LINK: 18,
  UNI: 18,
}

function scale(n: string | number, divisor: number): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return v / divisor
}

interface GmxPositionRow {
  id: string
  account: string
  marketAddress: string
  collateralTokenAddress: string
  sizeInUsd: string
  sizeInTokens: string
  collateralAmount: string
  isLong: boolean
  indexTokenSymbol?: string
  // Market info — fetched alongside or joined client-side
}

export async function fetchGmxPortfolio(address: string): Promise<TraderPortfolio | null> {
  const addr = address.toLowerCase()
  // GraphQL query: pull open positions for this trader, join the market for symbols
  // and indexPrice. The schema field names mirror what the GMX frontend uses;
  // we keep the query conservative to avoid breakage if optional fields change.
  const query = `
    query Positions($account: String!) {
      positions(
        where: { account: $account, sizeInUsd_gt: "0" }
        first: 50
        orderBy: sizeInUsd
        orderDirection: desc
      ) {
        id
        account
        marketAddress
        collateralTokenAddress
        sizeInUsd
        sizeInTokens
        collateralAmount
        isLong
        market {
          indexToken {
            symbol
            decimals
          }
          longToken { symbol decimals }
          shortToken { symbol decimals }
        }
      }
    }`

  let data: { positions?: Array<GmxPositionRow & {
    market?: {
      indexToken?: { symbol?: string; decimals?: number }
    }
  }> } | null = null
  try {
    const res = await fetch(SUBGRAPH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: addr } }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: typeof data; errors?: unknown }
    if (json.errors) return null
    data = json.data ?? null
  } catch {
    return null
  }

  const rows = data?.positions ?? []
  if (rows.length === 0) {
    return {
      platform: 'gmx',
      traderKey: address,
      totalNotionalUsd: 0,
      positions: [],
      fetchedAt: new Date().toISOString(),
      source: 'gmx-subgraph',
    }
  }

  const positions: Position[] = rows.map((p) => {
    const symbol = p.market?.indexToken?.symbol ?? 'UNKNOWN'
    const indexDecimals = p.market?.indexToken?.decimals ?? decimalsByToken[symbol] ?? 18
    const notional = scale(p.sizeInUsd, E30)
    const size = scale(p.sizeInTokens, 10 ** indexDecimals)
    // Entry price = sizeInUsd / sizeInTokens (both 1e30 / 1e<decimals>)
    const entryPrice = size > 0 ? notional / size : 0
    // GMX-v2 collateral is in collateral-token units; we approximate leverage
    // as notional / collateralUsd. Without the collateral USD value we'd need
    // a price feed, so leave undefined when uncertain.
    return {
      symbol,
      side: p.isLong ? 'long' : 'short',
      size,
      entryPrice,
      notionalUsd: notional,
    }
  })

  const totalNotional = positions.reduce((s, p) => s + p.notionalUsd, 0)

  return {
    platform: 'gmx',
    traderKey: address,
    totalNotionalUsd: totalNotional,
    positions,
    fetchedAt: new Date().toISOString(),
    source: 'gmx-subgraph',
  }
}

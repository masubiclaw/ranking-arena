/**
 * GMX position reader — v2 Synthetics (Arbitrum + Avalanche).
 *
 * Squids subgraph schema notes (verified via introspection 2026-05-15):
 *  - `market` and `collateralToken` are plain String (address), NOT nested objects.
 *  - Filter uses `account_eq`, NOT bare `account`.
 *  - Pagination arg is `limit` (not `first`); ordering is `orderBy: sizeInUsd_DESC`.
 *  - `isSnapshot_eq: false` filters snapshot-only rows; open positions have sizeInUsd > 0.
 *  - `sizeInUsd` and `entryPrice` are 1e30 BigInts; entryPrice scale is 10^(30-tokenDecimals).
 *  - `sizeInTokens` is in native token decimals (e.g. 1e18 for ETH, 1e8 for BTC).
 *  - Markets query gives market address → indexToken address mapping.
 */

import type { TraderPortfolio, Position } from './types'

const SUBGRAPHS = [
  'https://gmx.squids.live/gmx-synthetics-arbitrum/graphql',
  'https://gmx.squids.live/gmx-synthetics-avalanche/graphql',
] as const

// GMX v2 scales USD values as 1e30 BigInts.
const E30 = 1e30

// Static token-address → [symbol, decimals] for both Arbitrum and Avalanche.
// Lowercase keys. entryPrice scale = 10^(30 - decimals).
const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  // Arbitrum
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'BTC', decimals: 8 },
  '0x47904963fc8b2340414262125af798b9655e58cd': { symbol: 'BTC', decimals: 8 }, // GMX synthetic BTC
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'ETH', decimals: 18 },
  '0x2bcc6d6cdbbdc0a4071e48bb3b969b06b3330c07': { symbol: 'SOL', decimals: 9 },
  '0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', decimals: 18 },
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': { symbol: 'LINK', decimals: 18 },
  '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': { symbol: 'UNI', decimals: 18 },
  '0xc4da4c24fd591125c3f47b340b6f4f76111883d8': { symbol: 'DOGE', decimals: 8 },
  '0xb46a094bc4b0adbd801e14b9db95e05e28962764': { symbol: 'LTC', decimals: 8 },
  '0x13983f27ce9365055a6a553233c49fe28e70103e': { symbol: 'XRP', decimals: 6 },
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6 },
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  '0xc14e065b0067de91534e032868f5ac6ecf2c6868': { symbol: 'XRP', decimals: 6 },
  // Avalanche
  '0x50b7545627a5162f82a992c33b87adc75187b218': { symbol: 'BTC', decimals: 8 },
  '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab': { symbol: 'ETH', decimals: 18 },
  '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': { symbol: 'AVAX', decimals: 18 },
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', decimals: 6 },
  '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT', decimals: 6 },
  '0xd586e7f844cea2f87f50152665bcbc2c279d8d70': { symbol: 'DAI', decimals: 18 },
}

// Fallback for unlisted tokens: assume 18 decimals (most GMX synthetic indices use 18).
const DEFAULT_DECIMALS = 18

function metaFromAddress(addr: string) {
  return TOKEN_META[addr.toLowerCase()] ?? { symbol: addr.slice(0, 6) + '…', decimals: DEFAULT_DECIMALS }
}

// 1e30 BigInt string → USD float
function fromE30(n: string): number {
  const v = Number(n)
  return Number.isFinite(v) ? v / E30 : 0
}

// entryPrice is scaled by 10^(30 - tokenDecimals) in GMX v2.
function decodeEntryPrice(n: string, decimals: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return v / Math.pow(10, 30 - decimals)
}

const POSITIONS_QUERY = `
  query Positions($account: String!) {
    positions(
      where: { account_eq: $account, sizeInUsd_gt: "0", isSnapshot_eq: false }
      limit: 50
      orderBy: sizeInUsd_DESC
    ) {
      id
      market
      sizeInUsd
      sizeInTokens
      entryPrice
      isLong
    }
    markets(limit: 200) {
      id
      indexToken
    }
  }`

interface GmxRow {
  id: string
  market: string
  sizeInUsd: string
  sizeInTokens: string
  entryPrice: string
  isLong: boolean
}

interface GmxMarket {
  id: string
  indexToken: string
}

interface GmxResponse {
  positions?: GmxRow[]
  markets?: GmxMarket[]
}

async function querySubgraph(url: string, account: string): Promise<GmxResponse | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: POSITIONS_QUERY, variables: { account } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: GmxResponse; errors?: unknown }
    if (json.errors) return null
    return json.data ?? null
  } catch {
    return null
  }
}

export async function fetchGmxPortfolio(address: string): Promise<TraderPortfolio | null> {
  const account = address.toLowerCase()

  // Query both chains in parallel; merge results.
  const [arb, avax] = await Promise.all(
    SUBGRAPHS.map((url) => querySubgraph(url, account))
  )

  // Build market-address → indexToken-address map from whichever chains responded.
  const marketToIndex: Record<string, string> = {}
  for (const chain of [arb, avax]) {
    for (const m of chain?.markets ?? []) {
      marketToIndex[m.id.toLowerCase()] = m.indexToken.toLowerCase()
    }
  }

  const rows: GmxRow[] = [
    ...(arb?.positions ?? []),
    ...(avax?.positions ?? []),
  ]

  const positions: Position[] = rows.map((p) => {
    const indexToken = marketToIndex[p.market.toLowerCase()] ?? ''
    const { symbol, decimals } = metaFromAddress(indexToken)
    const notionalUsd = fromE30(p.sizeInUsd)
    const entryPrice = decodeEntryPrice(p.entryPrice, decimals)
    // sizeInTokens is in native token decimals (e.g. 1e18 for ETH, 1e8 for BTC).
    const size = Number(p.sizeInTokens) / Math.pow(10, decimals)
    return {
      symbol,
      side: p.isLong ? 'long' : 'short',
      size,
      entryPrice,
      notionalUsd,
    }
  })

  const totalNotionalUsd = positions.reduce((s, p) => s + p.notionalUsd, 0)

  return {
    platform: 'gmx',
    traderKey: address,
    totalNotionalUsd,
    positions,
    fetchedAt: new Date().toISOString(),
    source: 'gmx-subgraph',
  }
}

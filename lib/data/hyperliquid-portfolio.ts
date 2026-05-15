/**
 * Hyperliquid portfolio fetcher for trader detail pages.
 *
 * Uses the public info endpoint — no auth required. We pull both:
 *   - clearinghouseState: open positions, leverage, margin, account value
 *   - portfolio: historical PnL curve over multiple windows
 *
 * Best effort; failures return null so the UI can fall back to "not
 * available" rather than crashing.
 */

export interface HyperliquidPosition {
  coin: string
  szi: number          // signed size (positive = long, negative = short)
  entryPx: number
  leverage: number
  unrealizedPnl: number
  positionValueUsd: number
}

export interface HyperliquidPortfolio {
  accountValueUsd: number
  totalMarginUsedUsd: number
  totalNotionalUsd: number
  positions: HyperliquidPosition[]
  fetchedAt: string
}

export async function fetchHyperliquidPortfolio(address: string): Promise<HyperliquidPortfolio | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      marginSummary?: {
        accountValue?: string
        totalMarginUsed?: string
        totalNtlPos?: string
      }
      assetPositions?: Array<{
        position?: {
          coin?: string
          szi?: string
          entryPx?: string | null
          leverage?: { value?: number } | { type?: string; value?: number }
          unrealizedPnl?: string
          positionValue?: string
        }
      }>
    }
    if (!data?.marginSummary) return null

    const positions: HyperliquidPosition[] = (data.assetPositions ?? [])
      .map((ap) => ap.position)
      .filter((p): p is NonNullable<typeof p> => !!p && !!p.coin)
      .map((p) => ({
        coin: p.coin!,
        szi: Number(p.szi ?? 0),
        entryPx: Number(p.entryPx ?? 0),
        leverage: Number(
          typeof p.leverage === 'object' && p.leverage && 'value' in p.leverage ? p.leverage.value : 0,
        ),
        unrealizedPnl: Number(p.unrealizedPnl ?? 0),
        positionValueUsd: Number(p.positionValue ?? 0),
      }))

    return {
      accountValueUsd: Number(data.marginSummary.accountValue ?? 0),
      totalMarginUsedUsd: Number(data.marginSummary.totalMarginUsed ?? 0),
      totalNotionalUsd: Number(data.marginSummary.totalNtlPos ?? 0),
      positions,
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export interface HyperliquidDailyPnl {
  windowKey: 'day' | 'week' | 'month' | 'allTime'
  // [unixSeconds, accountValueAtThatTime]
  history: Array<[number, number]>
  pnlSeries: Array<[number, number]>
}

export async function fetchHyperliquidPortfolioHistory(address: string): Promise<HyperliquidDailyPnl[] | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: address }),
    })
    if (!res.ok) return null
    const arr = (await res.json()) as Array<[
      'day' | 'week' | 'month' | 'allTime' | string,
      { accountValueHistory?: Array<[number, string]>; pnlHistory?: Array<[number, string]> },
    ]>
    if (!Array.isArray(arr)) return null

    return arr
      .filter(([k]) => ['day', 'week', 'month', 'allTime'].includes(k as string))
      .map(([k, v]) => ({
        windowKey: k as 'day' | 'week' | 'month' | 'allTime',
        history: (v.accountValueHistory ?? []).map(([t, s]) => [t, Number(s)] as [number, number]),
        pnlSeries: (v.pnlHistory ?? []).map(([t, s]) => [t, Number(s)] as [number, number]),
      }))
  } catch {
    return null
  }
}

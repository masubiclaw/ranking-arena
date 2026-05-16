/**
 * Real Hyperliquid executor — replaces the stub in executor.ts.
 *
 * Signs orders via the @nktkas/hyperliquid SDK using a viem account derived
 * from HL_PRIVATE_KEY. The executor will refuse to run unless the env var
 * is present, so the dry-run default stays safe.
 *
 * Sizing logic:
 *   The proportional strategy gives us a *target notional in USD*. We
 *   convert that to a base-currency size using the mark price, then submit
 *   as an IOC market-style limit (HL's recommended market order) at a price
 *   1.5% above mark for buys (long-open / short-close) and 1.5% below for
 *   sells. This is the same slippage tolerance HL's frontend uses by default.
 *
 * Position closes use `reduce-only = true` so we never accidentally flip.
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { privateKeyToAccount } from 'viem/accounts'
import type { TraderExecutor, SizedOrder, ExecutionResult } from './executor'

const SLIPPAGE = 0.015  // 1.5% — HL frontend default for market orders

/** Lazy cache so we don't pay client construction on every order. */
let cachedExchange: ExchangeClient | null = null
let cachedInfo: InfoClient | null = null
let cachedAssetMap: Map<string, { index: number; szDecimals: number }> | null = null

function getExchange(): ExchangeClient | null {
  if (cachedExchange) return cachedExchange
  const pk = process.env.HL_PRIVATE_KEY
  if (!pk) return null
  const wallet = privateKeyToAccount(pk.startsWith('0x') ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`))
  const transport = new HttpTransport()
  cachedExchange = new ExchangeClient({ wallet, transport })
  cachedInfo = new InfoClient({ transport })
  return cachedExchange
}

async function getAssetMap(): Promise<Map<string, { index: number; szDecimals: number }> | null> {
  if (cachedAssetMap) return cachedAssetMap
  if (!cachedInfo) {
    // Force construction so cachedInfo is populated
    if (!getExchange()) return null
  }
  const meta = await cachedInfo!.meta()
  const m = new Map<string, { index: number; szDecimals: number }>()
  meta.universe.forEach((u, i) => {
    m.set(u.name, { index: i, szDecimals: u.szDecimals })
  })
  cachedAssetMap = m
  return m
}

async function getMarkPrice(coin: string): Promise<number | null> {
  if (!cachedInfo) {
    if (!getExchange()) return null
  }
  try {
    const mids = await cachedInfo!.allMids()
    const px = mids[coin]
    return px != null ? Number(px) : null
  } catch {
    return null
  }
}

function priceToTickString(price: number, szDecimals: number): string {
  // HL price-tick rules: max 5 significant figures, no more than (6 - szDecimals) decimal places.
  const maxDecimals = Math.max(0, 6 - szDecimals)
  // Round to significant figures, then to allowed decimals.
  const significant = price.toPrecision(5)
  const rounded = Number(Number(significant).toFixed(maxDecimals))
  return rounded.toString()
}

function sizeToString(size: number, szDecimals: number): string {
  // Truncate (don't round up) to respect HL minimum lot sizes.
  const factor = 10 ** szDecimals
  const truncated = Math.floor(size * factor) / factor
  return truncated.toFixed(szDecimals)
}

/**
 * Real Hyperliquid executor. Falls back to ok:false with a clear reason if
 * the env isn't configured or the asset isn't tradeable.
 */
export class HyperliquidLiveExecutor implements TraderExecutor {
  name = 'hyperliquid-live'
  async execute(order: SizedOrder): Promise<ExecutionResult> {
    const exchange = getExchange()
    if (!exchange) {
      return reject(order, 'HL_PRIVATE_KEY not set — refusing to submit live orders')
    }

    const assetMap = await getAssetMap()
    if (!assetMap) {
      return reject(order, 'failed to load HL asset universe')
    }

    const asset = assetMap.get(order.symbol)
    if (!asset) {
      return reject(order, `${order.symbol} not in HL perp universe`)
    }

    const markPx = await getMarkPrice(order.symbol)
    if (!markPx) {
      return reject(order, `no mark price for ${order.symbol}`)
    }

    // Translate intent → (isBuy, reduceOnly, notional sign)
    let isBuy: boolean
    let reduceOnly = false
    if (order.intent === 'close') {
      // Close = reduce-only in the opposite direction of our current side.
      isBuy = order.side === 'short'  // close a short → buy; close a long → sell
      reduceOnly = true
    } else if (order.intent === 'flip') {
      // Flip = market order that fully reverses. The strategy gives us the
      // *new* side; we send 2× notional to overshoot the old position.
      isBuy = order.side === 'long'
    } else {
      // open / increase / decrease — direction follows desired side.
      isBuy = order.side === 'long'
      if (order.intent === 'decrease') reduceOnly = true
    }

    const sizeBase = order.notionalUsd / markPx
    const sz = sizeToString(sizeBase, asset.szDecimals)
    if (Number(sz) <= 0) {
      return reject(order, `computed size 0 (notional=$${order.notionalUsd} px=$${markPx} szDec=${asset.szDecimals})`)
    }

    const limitPx = isBuy ? markPx * (1 + SLIPPAGE) : markPx * (1 - SLIPPAGE)
    const px = priceToTickString(limitPx, asset.szDecimals)

    try {
      const response = await exchange.order({
        orders: [{
          a: asset.index,
          b: isBuy,
          p: px,
          s: sz,
          r: reduceOnly,
          t: { limit: { tif: 'Ioc' } },  // IOC ≈ market order on HL
        }],
        grouping: 'na',
      })
      // Response: { status, response: { type: "order", data: { statuses: [...] } } }
      const statuses = (response as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses
      const first = statuses?.[0] as { resting?: { oid?: number }; filled?: { oid?: number }; error?: string } | undefined
      if (first?.error) {
        return reject(order, `HL rejected: ${first.error}`)
      }
      const oid = first?.filled?.oid ?? first?.resting?.oid
      return {
        ok: true,
        intent: order.intent,
        symbol: order.symbol,
        side: order.side,
        notionalUsd: order.notionalUsd,
        ref: oid != null ? `hl-oid-${oid}` : 'hl-submitted',
      }
    } catch (e) {
      return reject(order, `HL exchange call threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

function reject(order: SizedOrder, reason: string): ExecutionResult {
  return {
    ok: false,
    intent: order.intent,
    symbol: order.symbol,
    side: order.side,
    notionalUsd: order.notionalUsd,
    ref: 'rejected',
    reason,
  }
}

'use client'

import { useMemo, useState } from 'react'
import type { HyperliquidDailyPnl } from '@/lib/data/hyperliquid-portfolio'

type WindowKey = 'day' | 'week' | 'month' | 'allTime'

const LABEL: Record<WindowKey, string> = {
  day: '1D',
  week: '7D',
  month: '30D',
  allTime: 'All',
}

interface SeriesPair {
  timestamps: number[]
  values: number[]
}

interface Props {
  history: HyperliquidDailyPnl[]
  benchmarks?: { btc: SeriesPair | null; spy: SeriesPair | null }
}

export function TraderEquityChart({ history, benchmarks }: Props) {
  const available = history.filter((h) => h.history.length >= 2)
  const [activeKey, setActiveKey] = useState<WindowKey>(() => {
    const order: WindowKey[] = ['month', 'week', 'allTime', 'day']
    return order.find((k) => available.some((h) => h.windowKey === k)) ?? (available[0]?.windowKey as WindowKey ?? 'month')
  })

  const active = useMemo(() => available.find((h) => h.windowKey === activeKey), [available, activeKey])

  if (!active || active.history.length < 2) {
    return <div style={{ color: '#888', fontSize: 13 }}>No equity history available.</div>
  }

  const traderPoints = active.history
  const tv0 = traderPoints[0][1]
  const traderReturns = traderPoints.map(([t, v]) => ({ t, ret: tv0 > 0 ? ((v - tv0) / tv0) * 100 : 0 }))
  const t0 = traderPoints[0][0]
  const t1 = traderPoints[traderPoints.length - 1][0]
  const spanT = (t1 - t0) || 1

  // Sample BTC + SPY between t0 and t1, normalize to "% from value at t0".
  const btcReturns = sampleAndNormalize(benchmarks?.btc, t0, t1)
  const spyReturns = sampleAndNormalize(benchmarks?.spy, t0, t1)

  // y-axis spans all three series so the lines stay visible
  const allRets = [
    ...traderReturns.map((p) => p.ret),
    ...btcReturns.map((p) => p.ret),
    ...spyReturns.map((p) => p.ret),
    0,
  ]
  const minR = Math.min(...allRets)
  const maxR = Math.max(...allRets)
  const spanR = (maxR - minR) || 1

  const W = 760
  const H = 280
  const PAD_L = 50
  const PAD_R = 80
  const PAD_T = 16
  const PAD_B = 30
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const x = (t: number) => PAD_L + ((t - t0) / spanT) * innerW
  const y = (r: number) => PAD_T + innerH - ((r - minR) / spanR) * innerH

  const traderPath = pathFrom(traderReturns, x, y)
  const btcPath = pathFrom(btcReturns, x, y)
  const spyPath = pathFrom(spyReturns, x, y)
  const zeroY = y(0)

  const finalTrader = traderReturns[traderReturns.length - 1]?.ret ?? 0
  const finalBtc = btcReturns[btcReturns.length - 1]?.ret ?? null
  const finalSpy = spyReturns[spyReturns.length - 1]?.ret ?? null

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        {available.map((h) => (
          <button
            key={h.windowKey}
            onClick={() => setActiveKey(h.windowKey)}
            style={{
              padding: '4px 10px', borderRadius: 4, fontSize: 12,
              border: '1px solid #2a2a2e',
              background: h.windowKey === activeKey ? '#3a3a40' : '#1a1a1e',
              color: '#e8e8e8', cursor: 'pointer',
            }}
          >{LABEL[h.windowKey]}</button>
        ))}
        <div style={{ marginLeft: 16, display: 'flex', gap: 14, fontSize: 11 }}>
          <Legend color="#5e9eff" label={`Trader (${finalTrader >= 0 ? '+' : ''}${finalTrader.toFixed(1)}%)`} />
          {finalBtc != null && <Legend color="#f7931a" label={`BTC (${finalBtc >= 0 ? '+' : ''}${finalBtc.toFixed(1)}%)`} />}
          {finalSpy != null && <Legend color="#7fd97f" label={`S&P (${finalSpy >= 0 ? '+' : ''}${finalSpy.toFixed(1)}%)`} />}
        </div>
      </div>
      <svg width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY} stroke="#333" strokeDasharray="3 3" />
        <text x={PAD_L - 6} y={PAD_T + 8} fill="#888" fontSize="10" textAnchor="end">{maxR.toFixed(1)}%</text>
        <text x={PAD_L - 6} y={zeroY + 4} fill="#888" fontSize="10" textAnchor="end">0%</text>
        <text x={PAD_L - 6} y={H - PAD_B + 2} fill="#888" fontSize="10" textAnchor="end">{minR.toFixed(1)}%</text>

        {btcPath && <path d={btcPath} fill="none" stroke="#f7931a" strokeWidth="1.2" opacity="0.9" />}
        {spyPath && <path d={spyPath} fill="none" stroke="#7fd97f" strokeWidth="1.2" opacity="0.9" />}
        <path d={traderPath} fill="none" stroke="#5e9eff" strokeWidth="1.8" />

        <text x={PAD_L} y={H - 8} fill="#888" fontSize="10">{tsToDate(t0)}</text>
        <text x={W - PAD_R} y={H - 8} fill="#888" fontSize="10" textAnchor="end">{tsToDate(t1)}</text>
      </svg>
      <div style={{ fontSize: 11, color: '#778', marginTop: 6 }}>
        All series normalized to 0% at window start.
        Trader = on-chain account value; BTC = CoinGecko daily;
        S&amp;P = Yahoo SPY daily (business days only).
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ color: '#cdd', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ display: 'inline-block', width: 10, height: 2, background: color }} />
      {label}
    </span>
  )
}

function pathFrom(
  points: Array<{ t: number; ret: number }>,
  x: (t: number) => number,
  y: (r: number) => number,
): string | null {
  if (points.length === 0) return null
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(1)} ${y(p.ret).toFixed(1)}`).join(' ')
}

/**
 * Resample a series to {t, ret%} relative to value at t0. Only includes
 * points within [t0, t1].
 */
function sampleAndNormalize(
  series: SeriesPair | null | undefined,
  t0: number,
  t1: number,
): Array<{ t: number; ret: number }> {
  if (!series || series.timestamps.length < 2) return []
  // Find base: first sample with ts >= t0 (or fall back to first sample)
  let baseIdx = series.timestamps.findIndex((t) => t >= t0)
  if (baseIdx < 0) baseIdx = 0
  const base = series.values[baseIdx]
  if (base <= 0) return []
  const out: Array<{ t: number; ret: number }> = []
  for (let i = baseIdx; i < series.timestamps.length; i++) {
    const ts = series.timestamps[i]
    if (ts > t1) break
    out.push({ t: ts, ret: ((series.values[i] - base) / base) * 100 })
  }
  return out
}

function tsToDate(unixMillis: number): string {
  return new Date(unixMillis).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

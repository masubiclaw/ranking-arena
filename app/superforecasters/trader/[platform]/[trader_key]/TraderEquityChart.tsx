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

interface Props {
  history: HyperliquidDailyPnl[]
}

/**
 * Equity curve for a Hyperliquid trader.
 *
 * Note: we only have the trader's own account-value history from
 * Hyperliquid's portfolio endpoint. Comparing pointwise to BTC/S&P
 * requires per-day prices for those — which we don't yet ingest at a daily
 * granularity. For now we display the trader's normalized cumulative return
 * (starts at 0). When daily BTC/S&P caches are populated this component can
 * overlay them without other code changes.
 */
export function TraderEquityChart({ history }: Props) {
  const available = history.filter((h) => h.history.length >= 2)
  const [activeKey, setActiveKey] = useState<WindowKey>(() => {
    // Prefer month, then week, then allTime, then day
    const order: WindowKey[] = ['month', 'week', 'allTime', 'day']
    return order.find((k) => available.some((h) => h.windowKey === k)) ?? (available[0]?.windowKey as WindowKey ?? 'month')
  })

  const active = useMemo(() => available.find((h) => h.windowKey === activeKey), [available, activeKey])

  if (!active || active.history.length < 2) {
    return <div style={{ color: '#888', fontSize: 13 }}>No equity history available.</div>
  }

  const points = active.history
  const v0 = points[0][1]
  const returns = points.map(([t, v]) => ({ t, ret: v0 > 0 ? ((v - v0) / v0) * 100 : 0 }))
  const minR = Math.min(...returns.map((r) => r.ret), 0)
  const maxR = Math.max(...returns.map((r) => r.ret), 0)
  const spanR = (maxR - minR) || 1
  const t0 = points[0][0]
  const t1 = points[points.length - 1][0]
  const spanT = (t1 - t0) || 1

  const W = 760
  const H = 240
  const PAD_L = 50
  const PAD_R = 16
  const PAD_T = 16
  const PAD_B = 30
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const x = (t: number) => PAD_L + ((t - t0) / spanT) * innerW
  const y = (r: number) => PAD_T + innerH - ((r - minR) / spanR) * innerH

  const pathD = returns
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(1)} ${y(p.ret).toFixed(1)}`)
    .join(' ')

  const zeroY = y(0)

  const lastRet = returns[returns.length - 1].ret

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
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
      </div>
      <svg width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
        {/* zero line */}
        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY} stroke="#333" strokeDasharray="3 3" />
        {/* min/max labels */}
        <text x={PAD_L - 6} y={PAD_T + 8} fill="#888" fontSize="10" textAnchor="end">+{maxR.toFixed(1)}%</text>
        <text x={PAD_L - 6} y={zeroY + 4} fill="#888" fontSize="10" textAnchor="end">0%</text>
        <text x={PAD_L - 6} y={H - PAD_B + 2} fill="#888" fontSize="10" textAnchor="end">{minR.toFixed(1)}%</text>

        {/* equity curve */}
        <path d={pathD} fill="none" stroke="#5e9eff" strokeWidth="1.6" />

        {/* end-of-period marker */}
        <circle
          cx={x(returns[returns.length - 1].t)}
          cy={y(lastRet)}
          r={3}
          fill={lastRet >= 0 ? '#7fd97f' : '#ff8888'}
        />

        <text x={W - PAD_R} y={PAD_T + 12} fill={lastRet >= 0 ? '#7fd97f' : '#ff8888'}
          fontSize="12" textAnchor="end" fontWeight={600}>
          {lastRet >= 0 ? '+' : ''}{lastRet.toFixed(2)}% over period
        </text>

        {/* time labels */}
        <text x={PAD_L} y={H - 8} fill="#888" fontSize="10">{tsToDate(t0)}</text>
        <text x={W - PAD_R} y={H - 8} fill="#888" fontSize="10" textAnchor="end">{tsToDate(t1)}</text>
      </svg>
      <div style={{ fontSize: 11, color: '#778', marginTop: 6 }}>
        Showing trader's normalized account value (start = 0%). BTC and S&amp;P daily-overlay coming when daily price caches are populated.
      </div>
    </div>
  )
}

function tsToDate(unixMillis: number): string {
  const d = new Date(unixMillis)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

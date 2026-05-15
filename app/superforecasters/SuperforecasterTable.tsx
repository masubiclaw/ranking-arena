'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

type Window = '7D' | '30D' | '90D'

interface Trader {
  platform: string
  trader_key: string
  roi_pct: number | null
  pnl_usd: number | null
  max_drawdown: number | null
  trades_count: number | null
  arena_score: number | null
  sharpe_ratio: number | null
  sharpe_vs_btc: number | null
  shrunk_sharpe_vs_btc: number | null
  posterior_sd: number | null
  weight_to_prior: number | null
  p_superforecaster: number | null
  updated_at: string
}

interface Shrinkage {
  mu_pop: number
  tau_sq: number
  eligible_population: number
  superforecaster_threshold: number
  superforecaster_target_fraction: number
}

interface Props {
  initialWindow: Window
  initialData: {
    traders: Trader[]
    shrinkage: Shrinkage | null
    benchmark: { asset: 'BTC'; period_return_pct: number }
    window: Window
  }
}

type SortKey =
  | 'shrunk_sharpe_vs_btc'
  | 'p_superforecaster'
  | 'sharpe_vs_btc'
  | 'roi_pct'
  | 'pnl_usd'
  | 'max_drawdown'
  | 'trades_count'
  | 'weight_to_prior'
  | 'arena_score'

const COLS: { key: SortKey; label: string; fmt: (v: number | null) => string }[] = [
  { key: 'shrunk_sharpe_vs_btc', label: 'Shrunk',  fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'p_superforecaster',    label: 'P(SF)',   fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'sharpe_vs_btc',        label: 'Raw',     fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'roi_pct',              label: 'ROI %',   fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'pnl_usd',              label: 'PnL $',   fmt: (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`) },
  { key: 'max_drawdown',         label: 'DD %',    fmt: (v) => (v == null ? '—' : Math.abs(v).toFixed(2)) },
  { key: 'trades_count',         label: 'Trades',  fmt: (v) => (v == null ? '—' : `${v}`) },
  { key: 'weight_to_prior',      label: 'w→prior', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'arena_score',          label: 'Arena',   fmt: (v) => (v == null ? '—' : v.toFixed(0)) },
]

export function SuperforecasterTable({ initialWindow, initialData }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [sortKey, setSortKey] = useState<SortKey>('shrunk_sharpe_vs_btc')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')

  const sortedTraders = useMemo(() => {
    const arr = [...initialData.traders]
    arr.sort((a, b) => {
      const av = a[sortKey] as number | null
      const bv = b[sortKey] as number | null
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return arr
  }, [initialData.traders, sortKey, sortDir])

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const onWindowChange = (w: Window) => {
    startTransition(() => {
      router.push(`/superforecasters?window=${w}`)
    })
  }

  const shrinkage = initialData.shrinkage

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['7D', '30D', '90D'] as Window[]).map((w) => (
            <button
              key={w}
              onClick={() => onWindowChange(w)}
              disabled={isPending}
              style={{
                padding: '6px 14px', borderRadius: 6, border: '1px solid #2a2a2e',
                background: w === initialWindow ? '#3a3a40' : '#1a1a1e',
                color: '#e8e8e8', cursor: 'pointer', fontSize: 13,
                opacity: isPending ? 0.6 : 1,
              }}
            >{w}</button>
          ))}
        </div>
        {shrinkage && (
          <div style={{ fontSize: 12, color: '#9aa' }}>
            n={shrinkage.eligible_population} ·
            μ_pop={shrinkage.mu_pop} ·
            τ²={shrinkage.tau_sq} ·
            SF threshold ≥ {shrinkage.superforecaster_threshold}
            {initialData.benchmark && ` · BTC ${initialData.window}: ${initialData.benchmark.period_return_pct}%`}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#9aa', marginLeft: 'auto' }}>
          {sortedTraders.length} rows · click a header to sort
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2e', textAlign: 'left' }}>
              <th style={th}>#</th>
              <th style={th}>Platform</th>
              <th style={th}>Trader</th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  style={{ ...th, cursor: 'pointer', textAlign: 'right', userSelect: 'none' }}
                  onClick={() => onHeaderClick(c.key)}
                >
                  {c.label}{' '}
                  <span style={{ color: '#666', fontSize: 11 }}>
                    {sortKey === c.key ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedTraders.map((t, i) => {
              const pSf = t.p_superforecaster ?? 0
              const isSf = pSf >= 0.95
              return (
                <tr key={`${t.platform}:${t.trader_key}`} style={{ borderBottom: '1px solid #1a1a1e' }}>
                  <td style={{ ...td, color: '#888' }}>{i + 1}</td>
                  <td style={td}>{t.platform}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {t.trader_key.length > 22
                      ? `${t.trader_key.slice(0, 8)}…${t.trader_key.slice(-6)}`
                      : t.trader_key}
                  </td>
                  {COLS.map((c) => {
                    const v = t[c.key] as number | null
                    const isPSf = c.key === 'p_superforecaster'
                    return (
                      <td key={c.key} style={{
                        ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: isPSf && isSf ? '#7fd97f' : isPSf && pSf >= 0.7 ? '#dccd7f' : '#e8e8e8',
                        fontWeight: c.key === sortKey ? 600 : 400,
                      }}>
                        {c.fmt(v)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '10px 12px', fontWeight: 500, color: '#aab',
  fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
}
const td: React.CSSProperties = { padding: '8px 12px' }

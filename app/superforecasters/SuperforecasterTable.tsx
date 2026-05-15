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
    distribution: {
      shrunk: number[]
      pSf: number[]
      raw: number[]
    }
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

const COLS: { key: SortKey; label: string; tooltip?: string; fmt: (v: number | null) => string }[] = [
  { key: 'shrunk_sharpe_vs_btc', label: 'Shrunk', tooltip: 'Empirical-Bayes shrunk Sharpe-vs-BTC',
    fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'p_superforecaster', label: 'P(SF)', tooltip: 'Posterior probability of being in the top 5%',
    fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'sharpe_vs_btc', label: 'Raw', tooltip: 'Raw (uncapped, unshrunk) Sharpe-vs-BTC',
    fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'roi_pct', label: 'ROI %', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'pnl_usd', label: 'PnL $', fmt: (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`) },
  { key: 'max_drawdown', label: 'DD %', fmt: (v) => (v == null ? '—' : Math.abs(v).toFixed(2)) },
  { key: 'trades_count', label: 'Trades', fmt: (v) => (v == null ? '—' : `${v}`) },
  { key: 'weight_to_prior', label: 'w→prior', tooltip: 'Shrinkage weight: 0 = trust data fully, 1 = use prior',
    fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
  { key: 'arena_score', label: 'Arena', fmt: (v) => (v == null ? '—' : v.toFixed(0)) },
]

export function SuperforecasterTable({ initialWindow, initialData }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [sortKey, setSortKey] = useState<SortKey>('shrunk_sharpe_vs_btc')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')

  const sortedTraders = useMemo(() => {
    const arr = [...initialData.traders]
    arr.sort((a, b) => {
      const rawA = a[sortKey]
      const rawB = b[sortKey]
      // Coerce defensively in case anything slipped through as a string.
      const av = rawA == null ? null : typeof rawA === 'number' ? rawA : Number(rawA)
      const bv = rawB == null ? null : typeof rawB === 'number' ? rawB : Number(rawB)
      const aBad = av == null || !Number.isFinite(av)
      const bBad = bv == null || !Number.isFinite(bv)
      if (aBad && bBad) return 0
      if (aBad) return 1  // nulls always at bottom regardless of direction
      if (bBad) return -1
      return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
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
    startTransition(() => router.push(`/superforecasters?window=${w}`))
  }

  const onRowClick = (t: Trader) => {
    router.push(`/superforecasters/trader/${t.platform}/${encodeURIComponent(t.trader_key)}?window=${initialWindow}`)
  }

  const shrinkage = initialData.shrinkage
  const dist = initialData.distribution

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
            n={shrinkage.eligible_population} · μ_pop={shrinkage.mu_pop} ·
            τ²={shrinkage.tau_sq} · SF threshold ≥ {shrinkage.superforecaster_threshold}
            {' '}· BTC {initialData.window}: {initialData.benchmark.period_return_pct}%
          </div>
        )}
        <div style={{ fontSize: 12, color: '#9aa', marginLeft: 'auto' }}>
          showing top {sortedTraders.length} · click row for detail · click header to sort
        </div>
      </div>

      <DistributionRow distribution={dist} sfThreshold={shrinkage?.superforecaster_threshold ?? 0} />

      <div style={{ overflowX: 'auto', marginTop: 16 }}>
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
                  title={c.tooltip}
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
                <tr
                  key={`${t.platform}:${t.trader_key}`}
                  onClick={() => onRowClick(t)}
                  style={{ borderBottom: '1px solid #1a1a1e', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#1a1a20')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
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

// ── Distribution Row ─────────────────────────────────────────────────────────

function DistributionRow({
  distribution,
  sfThreshold,
}: {
  distribution: Props['initialData']['distribution']
  sfThreshold: number
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
      <Histogram
        title="Shrunk Sharpe-vs-BTC"
        subtitle="full eligible population"
        values={distribution.shrunk}
        nBins={20}
        marker={{ at: sfThreshold, label: `SF ≥ ${sfThreshold.toFixed(2)}` }}
        decimals={2}
      />
      <Histogram
        title="P(superforecaster)"
        subtitle="posterior probability of top-5%"
        values={distribution.pSf}
        nBins={20}
        range={[0, 1]}
        decimals={2}
      />
      <Histogram
        title="Raw Sharpe-vs-BTC"
        subtitle="before capping & shrinkage (clipped at ±30 for display)"
        values={distribution.raw.map((v) => Math.max(-30, Math.min(30, v)))}
        nBins={20}
        decimals={1}
      />
    </div>
  )
}

function Histogram({
  title, subtitle, values, nBins, marker, range, decimals = 2,
}: {
  title: string
  subtitle?: string
  values: number[]
  nBins: number
  marker?: { at: number; label: string }
  range?: [number, number]
  decimals?: number
}) {
  const W = 280
  const H = 80
  const PAD_L = 6
  const PAD_R = 6
  const PAD_T = 4
  const PAD_B = 18
  if (values.length === 0) {
    return <Card title={title} subtitle={subtitle}><div style={{ height: H, color: '#777', fontSize: 12 }}>no data</div></Card>
  }
  const lo = range ? range[0] : Math.min(...values)
  const hi = range ? range[1] : Math.max(...values)
  const span = hi - lo || 1
  const binW = span / nBins
  const counts = new Array(nBins).fill(0)
  for (const v of values) {
    const idx = Math.min(nBins - 1, Math.max(0, Math.floor((v - lo) / binW)))
    counts[idx]++
  }
  const maxC = Math.max(...counts) || 1

  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const barGap = 1
  const barW = innerW / nBins - barGap

  return (
    <Card title={title} subtitle={subtitle}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {counts.map((c, i) => {
          const x = PAD_L + i * (innerW / nBins)
          const h = (c / maxC) * innerH
          const y = PAD_T + innerH - h
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barW}
              height={h}
              fill={c === maxC ? '#5e9eff' : '#3f6ec0'}
              opacity={0.85}
            />
          )
        })}
        {marker && marker.at >= lo && marker.at <= hi && (
          <>
            <line
              x1={PAD_L + ((marker.at - lo) / span) * innerW}
              x2={PAD_L + ((marker.at - lo) / span) * innerW}
              y1={PAD_T}
              y2={PAD_T + innerH}
              stroke="#7fd97f"
              strokeDasharray="2 2"
            />
            <text
              x={PAD_L + ((marker.at - lo) / span) * innerW + 4}
              y={PAD_T + 10}
              fill="#7fd97f"
              fontSize="9"
            >
              {marker.label}
            </text>
          </>
        )}
        <text x={PAD_L} y={H - 4} fill="#888" fontSize="10">
          {lo.toFixed(decimals)}
        </text>
        <text x={W - PAD_R} y={H - 4} fill="#888" fontSize="10" textAnchor="end">
          {hi.toFixed(decimals)}
        </text>
        <text x={W / 2} y={H - 4} fill="#888" fontSize="10" textAnchor="middle">
          n = {values.length}
        </text>
      </svg>
    </Card>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid #2a2a2e', borderRadius: 8, padding: '10px 12px',
      background: '#15151a',
    }}>
      <div style={{ fontSize: 12, color: '#cdd', fontWeight: 500 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 10.5, color: '#778', marginBottom: 4 }}>{subtitle}</div>}
      {children}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '10px 12px', fontWeight: 500, color: '#aab',
  fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
}
const td: React.CSSProperties = { padding: '8px 12px' }

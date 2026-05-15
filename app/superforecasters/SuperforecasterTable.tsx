'use client'

import { useEffect, useMemo, useState } from 'react'

type Window = '7D' | '30D' | '90D'

interface Trader {
  rank: number
  platform: string
  trader_key: string
  roi_pct: number | null
  pnl_usd: number | null
  max_drawdown_pct: number | null
  trades_count: number | null
  arena_score: number | null
  sharpe_ratio: number | null
  sharpe_vs_btc: number | null
  shrunk_sharpe_vs_btc: number | null
  posterior_sd: number | null
  weight_to_prior: number | null
  p_superforecaster: number | null
  score: number | null
  updated_at: string
}

interface ApiResponse {
  criterion: string
  window: Window
  computed_at: string
  data_freshness: { latest_snapshot_at: string | null; age_seconds: number | null }
  benchmark?: { asset: 'BTC'; period_return_pct: number }
  shrinkage?: {
    mu_pop: number
    tau_sq: number
    mean_sigma_sq: number
    eligible_population: number
    superforecaster_threshold: number
    superforecaster_target_fraction: number
  }
  count: number
  traders: Trader[]
}

type SortKey =
  | 'shrunk_sharpe_vs_btc'
  | 'p_superforecaster'
  | 'sharpe_vs_btc'
  | 'roi_pct'
  | 'pnl_usd'
  | 'max_drawdown_pct'
  | 'trades_count'
  | 'weight_to_prior'

const COLS: { key: SortKey; label: string; fmt: (v: number | null) => string; numeric: boolean }[] = [
  { key: 'shrunk_sharpe_vs_btc', label: 'Shrunk', fmt: (v) => (v == null ? '—' : v.toFixed(2)), numeric: true },
  { key: 'p_superforecaster', label: 'P(SF)', fmt: (v) => (v == null ? '—' : v.toFixed(2)), numeric: true },
  { key: 'sharpe_vs_btc', label: 'Raw', fmt: (v) => (v == null ? '—' : v.toFixed(2)), numeric: true },
  { key: 'roi_pct', label: 'ROI %', fmt: (v) => (v == null ? '—' : v.toFixed(2)), numeric: true },
  { key: 'pnl_usd', label: 'PnL $', fmt: (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`), numeric: true },
  { key: 'max_drawdown_pct', label: 'DD %', fmt: (v) => (v == null ? '—' : v.toFixed(2)), numeric: true },
  { key: 'trades_count', label: 'Trades', fmt: (v) => (v == null ? '—' : `${v}`), numeric: true },
  { key: 'weight_to_prior', label: 'w→prior', fmt: (v) => (v == null ? '—' : v.toFixed(2)), numeric: true },
]

export function SuperforecasterTable() {
  const [window, setWindow] = useState<Window>('90D')
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('shrunk_sharpe_vs_btc')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [apiKey, setApiKey] = useState<string>('')

  useEffect(() => {
    // Pull saved key from localStorage so the user doesn't re-paste each load.
    const saved = typeof globalThis !== 'undefined' && globalThis.localStorage
      ? localStorage.getItem('arena_bot_api_key') ?? ''
      : ''
    setApiKey(saved)
  }, [])

  useEffect(() => {
    let aborted = false
    setLoading(true)
    setError(null)
    const url = `/api/top-traders?criterion=shrunk_sharpe_vs_btc&window=${window}&limit=200`
    fetch(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {})
      .then(async (r) => {
        const json = await r.json().catch(() => null)
        if (!r.ok) throw new Error(json?.error ?? `HTTP ${r.status}`)
        return json as ApiResponse
      })
      .then((j) => { if (!aborted) setData(j) })
      .catch((e) => { if (!aborted) setError(e.message ?? String(e)) })
      .finally(() => { if (!aborted) setLoading(false) })
    return () => { aborted = true }
  }, [window, apiKey])

  const sortedTraders = useMemo(() => {
    if (!data) return []
    const arr = [...data.traders]
    arr.sort((a, b) => {
      const av = a[sortKey] as number | null
      const bv = b[sortKey] as number | null
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return arr
  }, [data, sortKey, sortDir])

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const saveKey = (v: string) => {
    setApiKey(v)
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      localStorage.setItem('arena_bot_api_key', v)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['7D', '30D', '90D'] as Window[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: '1px solid #2a2a2e',
                background: w === window ? '#3a3a40' : '#1a1a1e',
                color: '#e8e8e8', cursor: 'pointer', fontSize: 13,
              }}
            >{w}</button>
          ))}
        </div>
        <input
          type="password"
          placeholder="BOT_API_KEY (saved to localStorage)"
          value={apiKey}
          onChange={(e) => saveKey(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: 6, border: '1px solid #2a2a2e',
            background: '#1a1a1e', color: '#e8e8e8', fontSize: 13, width: 320,
          }}
        />
        {data?.shrinkage && (
          <div style={{ fontSize: 12, color: '#9aa' }}>
            n={data.shrinkage.eligible_population} ·
            μ={data.shrinkage.mu_pop} ·
            τ²={data.shrinkage.tau_sq} ·
            SF threshold ≥ {data.shrinkage.superforecaster_threshold}
            {data.benchmark && ` · BTC ${data.window}: ${data.benchmark.period_return_pct}%`}
          </div>
        )}
      </div>

      {loading && <div style={{ color: '#9aa' }}>Loading…</div>}
      {error && <div style={{ color: '#f88' }}>Error: {error}</div>}
      {!loading && !error && data && (
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
                    style={{ ...th, cursor: 'pointer', textAlign: 'right' }}
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
                const isSf = (t.p_superforecaster ?? 0) >= 0.95
                return (
                  <tr key={`${t.platform}:${t.trader_key}`} style={{ borderBottom: '1px solid #1a1a1e' }}>
                    <td style={{ ...td, color: '#888' }}>{i + 1}</td>
                    <td style={td}>{t.platform}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                      {t.trader_key.length > 22 ? `${t.trader_key.slice(0, 8)}…${t.trader_key.slice(-6)}` : t.trader_key}
                    </td>
                    {COLS.map((c) => {
                      const v = t[c.key] as number | null
                      const isPSf = c.key === 'p_superforecaster'
                      return (
                        <td key={c.key} style={{
                          ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                          color: isPSf && isSf ? '#7fd97f' : isPSf && (v ?? 0) >= 0.7 ? '#dccd7f' : '#e8e8e8',
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
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '10px 12px', fontWeight: 500, color: '#aab',
  fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
}
const td: React.CSSProperties = { padding: '8px 12px' }

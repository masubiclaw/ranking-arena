import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseAdmin } from '@/lib/api'
import { getBtcBenchmark } from '@/lib/data/btc-returns'
import { getSp500Returns } from '@/lib/data/sp500-returns'
import { fetchHyperliquidPortfolioHistory } from '@/lib/data/hyperliquid-portfolio'
import { fetchPortfolio, SUPPORTED_POSITION_PLATFORMS } from '@/lib/data/positions'
import type { TraderPortfolio } from '@/lib/data/positions'
import { aggregateExcessSharpe } from '@/lib/utils/benchmark-sharpe'
import { TraderEquityChart } from './TraderEquityChart'

export const dynamic = 'force-dynamic'

const WINDOWS = ['7D', '30D', '90D'] as const
type Window = typeof WINDOWS[number]
const PERIOD_DAYS: Record<Window, 7 | 30 | 90> = { '7D': 7, '30D': 30, '90D': 90 }

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchPerWindowStats(platform: string, traderKey: string) {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('trader_snapshots_v2')
    .select('window, roi_pct, pnl_usd, max_drawdown, trades_count, arena_score, sharpe_ratio, updated_at')
    .eq('platform', platform)
    .eq('trader_key', traderKey)
    .order('updated_at', { ascending: false })
    .limit(20)
  const byWindow: Record<Window, ReturnType<typeof normalizeRow> | null> = { '7D': null, '30D': null, '90D': null }
  for (const r of data ?? []) {
    const w = r.window as Window
    if (WINDOWS.includes(w) && !byWindow[w]) byWindow[w] = normalizeRow(r)
  }
  return byWindow
}

function normalizeRow(r: Record<string, unknown>) {
  return {
    roi_pct: num(r.roi_pct),
    pnl_usd: num(r.pnl_usd),
    max_drawdown: num(r.max_drawdown),
    trades_count: num(r.trades_count),
    arena_score: num(r.arena_score),
    sharpe_ratio: num(r.sharpe_ratio),
    updated_at: String(r.updated_at ?? ''),
  }
}

async function fetchBtcSp500ForAllWindows() {
  const out: Record<Window, { btc: number | null; sp500: number | null }> = {
    '7D': { btc: null, sp500: null },
    '30D': { btc: null, sp500: null },
    '90D': { btc: null, sp500: null },
  }
  await Promise.all(
    WINDOWS.map(async (w) => {
      const days = PERIOD_DAYS[w]
      try {
        const btc = await getBtcBenchmark(w)
        out[w].btc = btc.periodReturnPct
      } catch { /* leave null */ }
      try {
        const sp = await getSp500Returns(days)
        out[w].sp500 = sp.periodReturnPct
      } catch { /* leave null */ }
    }),
  )
  return out
}

export default async function TraderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string; trader_key: string }>
  searchParams?: Promise<{ window?: string }>
}) {
  const { platform, trader_key } = await params
  const sp = (await searchParams) ?? {}
  const decodedKey = decodeURIComponent(trader_key)
  const activeWindow: Window = WINDOWS.includes((sp.window ?? '90D').toUpperCase() as Window)
    ? ((sp.window ?? '90D').toUpperCase() as Window)
    : '90D'

  const [windowStats, benchmarks] = await Promise.all([
    fetchPerWindowStats(platform, decodedKey),
    fetchBtcSp500ForAllWindows(),
  ])

  const hasAnyData = Object.values(windowStats).some((s) => s != null)
  if (!hasAnyData) notFound()

  // Live portfolio across supported platforms (Hyperliquid + GMX + dYdX so far).
  // Hyperliquid additionally has a portfolio-history endpoint that we use for
  // the equity curve below.
  const positionsSupported = SUPPORTED_POSITION_PLATFORMS.has(platform)
  const [portfolio, portfolioHistory] = await Promise.all([
    positionsSupported ? fetchPortfolio(platform, decodedKey) : Promise.resolve(null),
    platform === 'hyperliquid'
      ? fetchHyperliquidPortfolioHistory(decodedKey)
      : Promise.resolve(null),
  ])

  return (
    <main style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto', color: '#e8e8e8' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href={`/superforecasters?window=${activeWindow}`} style={{ color: '#7aa', fontSize: 13, textDecoration: 'none' }}>
          ← back to leaderboard
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: '8px 0 4px' }}>
          {platform} · <span style={{ fontFamily: 'ui-monospace, monospace' }}>{shortKey(decodedKey)}</span>
        </h1>
        <div style={{ color: '#9aa', fontSize: 13 }}>
          {portfolio
            ? `${portfolio.accountValueUsd != null ? `account ≈ $${Math.round(portfolio.accountValueUsd).toLocaleString()} · ` : ''}${portfolio.positions.length} open position${portfolio.positions.length === 1 ? '' : 's'} · source: ${portfolio.source}`
            : positionsSupported
            ? 'no open positions or trader address not found on platform'
            : `live positions not yet wired for ${platform}`}
        </div>
      </header>

      <section style={section}>
        <h2 style={h2}>Return vs Benchmarks</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={comparisonTable}>
            <thead>
              <tr>
                <th style={th}>Window</th>
                <th style={thRight}>Trader ROI</th>
                <th style={thRight}>BTC</th>
                <th style={thRight}>S&amp;P 500</th>
                <th style={thRight}>Excess vs BTC</th>
                <th style={thRight}>Excess vs S&amp;P</th>
                <th style={thRight}>Max DD</th>
                <th style={thRight}>Sharpe-vs-BTC</th>
                <th style={thRight}>Trades</th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map((w) => {
                const t = windowStats[w]
                const b = benchmarks[w]
                if (!t) {
                  return (
                    <tr key={w}>
                      <td style={td}>{w}</td>
                      <td colSpan={8} style={{ ...tdRight, color: '#666' }}>no snapshot</td>
                    </tr>
                  )
                }
                const roi = t.roi_pct
                const dd = t.max_drawdown
                const svb = roi != null
                  ? aggregateExcessSharpe(roi, b.btc ?? 0, dd, PERIOD_DAYS[w])
                  : null
                const excessBtc = roi != null && b.btc != null ? roi - b.btc : null
                const excessSp = roi != null && b.sp500 != null ? roi - b.sp500 : null
                return (
                  <tr key={w}>
                    <td style={td}><strong>{w}</strong></td>
                    <td style={tdRight}><Pct v={roi} /></td>
                    <td style={tdRight}><Pct v={b.btc} /></td>
                    <td style={tdRight}><Pct v={b.sp500} /></td>
                    <td style={tdRight}><Pct v={excessBtc} /></td>
                    <td style={tdRight}><Pct v={excessSp} /></td>
                    <td style={tdRight}>{dd == null ? '—' : `${Math.abs(dd).toFixed(2)}%`}</td>
                    <td style={tdRight}>{svb == null ? '—' : svb.toFixed(2)}</td>
                    <td style={tdRight}>{t.trades_count ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <ComparisonBars windowStats={windowStats} benchmarks={benchmarks} />
      </section>

      {portfolioHistory && portfolioHistory.length > 0 && (
        <section style={section}>
          <h2 style={h2}>Equity curve vs BTC vs S&amp;P</h2>
          <TraderEquityChart history={portfolioHistory} />
        </section>
      )}

      <section style={section}>
        <h2 style={h2}>Portfolio composition</h2>
        {portfolio ? (
          portfolio.positions.length === 0 ? (
            <div style={{ color: '#888' }}>No open positions.</div>
          ) : (
            <PortfolioBreakdown portfolio={portfolio} />
          )
        ) : (
          <div style={{ color: '#888', fontSize: 13 }}>
            Live portfolio composition is currently only available for Hyperliquid
            (public on-chain API). Other platforms expose this only behind
            authenticated copy-trading endpoints.
          </div>
        )}
      </section>
    </main>
  )
}

function shortKey(k: string) {
  return k.startsWith('0x') && k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-6)}` : k
}

function Pct({ v }: { v: number | null }) {
  if (v == null) return <span style={{ color: '#666' }}>—</span>
  const color = v >= 0 ? '#7fd97f' : '#ff8888'
  const sign = v >= 0 ? '+' : ''
  return <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>{sign}{v.toFixed(2)}%</span>
}

function ComparisonBars({
  windowStats,
  benchmarks,
}: {
  windowStats: Record<Window, ReturnType<typeof normalizeRow> | null>
  benchmarks: Record<Window, { btc: number | null; sp500: number | null }>
}) {
  // For each window, draw three bars: trader ROI, BTC, S&P 500
  const data = WINDOWS.map((w) => {
    const t = windowStats[w]
    return {
      window: w,
      trader: t?.roi_pct ?? null,
      btc: benchmarks[w].btc,
      sp500: benchmarks[w].sp500,
    }
  })

  const allVals = data.flatMap((d) => [d.trader, d.btc, d.sp500]).filter((v): v is number => v != null)
  if (allVals.length === 0) return null
  const maxAbs = Math.max(...allVals.map(Math.abs), 1)

  const W = 760
  const H = 200
  const PAD_L = 60
  const PAD_R = 16
  const PAD_T = 16
  const PAD_B = 30
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const midY = PAD_T + innerH / 2
  const groupW = innerW / data.length
  const barW = (groupW - 16) / 3

  return (
    <svg width={W} height={H} style={{ display: 'block', marginTop: 12, maxWidth: '100%' }}>
      {/* zero axis */}
      <line x1={PAD_L} y1={midY} x2={W - PAD_R} y2={midY} stroke="#333" />
      {/* y-axis labels */}
      <text x={PAD_L - 6} y={midY + 4} fill="#888" fontSize="10" textAnchor="end">0%</text>
      <text x={PAD_L - 6} y={PAD_T + 8} fill="#888" fontSize="10" textAnchor="end">+{maxAbs.toFixed(0)}%</text>
      <text x={PAD_L - 6} y={H - PAD_B + 2} fill="#888" fontSize="10" textAnchor="end">-{maxAbs.toFixed(0)}%</text>

      {data.map((d, i) => {
        const x0 = PAD_L + i * groupW + 8
        return (
          <g key={d.window}>
            {[
              { v: d.trader, color: '#5e9eff', label: 'Trader', x: x0 },
              { v: d.btc, color: '#f7931a', label: 'BTC', x: x0 + barW + 4 },
              { v: d.sp500, color: '#7fd97f', label: 'S&P', x: x0 + (barW + 4) * 2 },
            ].map((b) => {
              if (b.v == null) return null
              const h = Math.abs(b.v / maxAbs) * (innerH / 2)
              const y = b.v >= 0 ? midY - h : midY
              return (
                <g key={b.label}>
                  <rect x={b.x} y={y} width={barW} height={h} fill={b.color} opacity={0.9}>
                    <title>{`${b.label} (${d.window}): ${b.v.toFixed(2)}%`}</title>
                  </rect>
                  <text x={b.x + barW / 2} y={b.v >= 0 ? y - 3 : y + h + 11} fill="#aaa"
                    fontSize="9" textAnchor="middle">
                    {b.v >= 0 ? '+' : ''}{b.v.toFixed(0)}%
                  </text>
                </g>
              )
            })}
            <text x={x0 + (groupW - 16) / 2} y={H - 8} fill="#cdd" fontSize="11" textAnchor="middle" fontWeight={500}>
              {d.window}
            </text>
          </g>
        )
      })}

      {/* Legend */}
      <g transform={`translate(${PAD_L}, ${H - 4})`}>
        <rect x={0} y={-9} width={10} height={8} fill="#5e9eff" /><text x={14} y={-1} fill="#cdd" fontSize="10">Trader</text>
        <rect x={70} y={-9} width={10} height={8} fill="#f7931a" /><text x={84} y={-1} fill="#cdd" fontSize="10">BTC</text>
        <rect x={130} y={-9} width={10} height={8} fill="#7fd97f" /><text x={144} y={-1} fill="#cdd" fontSize="10">S&amp;P 500</text>
      </g>
    </svg>
  )
}

function PortfolioBreakdown({ portfolio }: { portfolio: TraderPortfolio }) {
  const total = portfolio.totalNotionalUsd
  const sorted = [...portfolio.positions].sort((a, b) => b.notionalUsd - a.notionalUsd)
  return (
    <div>
      <div style={{ fontSize: 12, color: '#9aa', marginBottom: 10 }}>
        Total notional: ${Math.round(total).toLocaleString()}
        {portfolio.accountValueUsd != null && ` · Account value: $${Math.round(portfolio.accountValueUsd).toLocaleString()}`}
      </div>
      <table style={comparisonTable}>
        <thead>
          <tr>
            <th style={th}>Coin</th>
            <th style={thRight}>Side</th>
            <th style={thRight}>Size</th>
            <th style={thRight}>Entry</th>
            <th style={thRight}>Notional</th>
            <th style={thRight}>% of book</th>
            <th style={thRight}>Lev</th>
            <th style={thRight}>uPnL</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const pct = total > 0 ? (p.notionalUsd / total) * 100 : 0
            return (
              <tr key={p.symbol}>
                <td style={td}><strong>{p.symbol}</strong></td>
                <td style={{ ...tdRight, color: p.side === 'long' ? '#7fd97f' : '#ff8888' }}>
                  {p.side.toUpperCase()}
                </td>
                <td style={tdRight}>{p.size.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                <td style={tdRight}>${p.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                <td style={tdRight}>${Math.round(p.notionalUsd).toLocaleString()}</td>
                <td style={tdRight}>{pct.toFixed(1)}%</td>
                <td style={tdRight}>{p.leverage != null ? `${p.leverage.toFixed(0)}x` : '—'}</td>
                <td style={{
                  ...tdRight,
                  color: p.unrealizedPnlUsd == null ? '#9aa' : p.unrealizedPnlUsd >= 0 ? '#7fd97f' : '#ff8888',
                }}>
                  {p.unrealizedPnlUsd == null ? '—' : `$${Math.round(p.unrealizedPnlUsd).toLocaleString()}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const section: React.CSSProperties = { marginBottom: 28 }
const h2: React.CSSProperties = { fontSize: 16, fontWeight: 500, color: '#cdd', margin: '0 0 12px' }
const comparisonTable: React.CSSProperties = { borderCollapse: 'collapse', width: '100%', fontSize: 13 }
const th: React.CSSProperties = { padding: '8px 12px', fontWeight: 500, color: '#aab', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #2a2a2e', textAlign: 'left' }
const thRight: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #1a1a1e' }
const tdRight: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

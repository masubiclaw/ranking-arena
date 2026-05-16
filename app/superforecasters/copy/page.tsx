import Link from 'next/link'
import { getSupabaseAdmin } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Copy Loop — Arena',
  description: 'Position-change stream and copy-trading executor monitor.',
}

interface TrackedTrader {
  platform: string
  trader_key: string
  added_at: string
  last_polled: string | null
  note: string | null
  open_positions: number
  total_notional: number | null
}

interface PositionChange {
  id: number
  detected_at: string
  platform: string
  trader_key: string
  symbol: string
  change_type: 'opened' | 'resized' | 'closed' | 'flipped'
  prev_side: string | null
  prev_size: number | null
  new_side: string | null
  new_size: number | null
  new_notional: number | null
  size_delta_pct: number | null
}

interface DryRunOrder {
  id: number
  follower: string
  symbol: string
  side: string
  intent: string
  target_notional_usd: number
  leverage: number
  submitted_at: string
}

async function fetchOverview() {
  const supabase = getSupabaseAdmin()

  const [
    { data: trackedRaw, count: trackedCount },
    { data: changes },
    { data: orders },
    { data: positions },
  ] = await Promise.all([
    supabase
      .from('tracked_traders')
      .select('platform, trader_key, added_at, last_polled, note', { count: 'exact' })
      .order('last_polled', { ascending: false, nullsFirst: false })
      .limit(100),
    supabase
      .from('position_changes')
      .select('*')
      .order('detected_at', { ascending: false })
      .limit(50),
    supabase
      .from('dry_run_orders')
      .select('*')
      .order('submitted_at', { ascending: false })
      .limit(50),
    supabase
      .from('trader_positions')
      .select('platform, trader_key, notional_usd'),
  ])

  const positionAggs = new Map<string, { count: number; notional: number }>()
  for (const p of positions ?? []) {
    const key = `${p.platform}:${p.trader_key}`
    const e = positionAggs.get(key) ?? { count: 0, notional: 0 }
    e.count += 1
    e.notional += Number(p.notional_usd ?? 0)
    positionAggs.set(key, e)
  }
  const tracked: TrackedTrader[] = (trackedRaw ?? []).map((t) => {
    const a = positionAggs.get(`${t.platform}:${t.trader_key}`)
    return {
      ...t,
      open_positions: a?.count ?? 0,
      total_notional: a?.notional ?? null,
    }
  })

  return {
    tracked,
    trackedCount: trackedCount ?? tracked.length,
    changes: (changes ?? []) as PositionChange[],
    orders: (orders ?? []) as DryRunOrder[],
    executor: process.env.EXECUTOR ?? 'dry-run',
    followerCapital: Number(process.env.FOLLOWER_CAPITAL_USD ?? 1000),
    maxNotional: Number(process.env.COPY_MAX_NOTIONAL_USD ?? 250),
    maxLeverage: Number(process.env.COPY_MAX_LEVERAGE ?? 3),
  }
}

export default async function CopyMonitor() {
  const d = await fetchOverview()

  const eventCount24h = d.changes.filter(
    (c) => Date.now() - new Date(c.detected_at).getTime() < 86_400_000,
  ).length
  const orderCount24h = d.orders.filter(
    (o) => Date.now() - new Date(o.submitted_at).getTime() < 86_400_000,
  ).length

  return (
    <main style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto', color: '#e8e8e8' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/superforecasters" style={{ color: '#7aa', fontSize: 13, textDecoration: 'none' }}>
          ← back to leaderboard
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: '8px 0 4px' }}>Copy Loop Monitor</h1>
        <div style={{ color: '#9aa', fontSize: 13 }}>
          Position-change stream and copy-trading executor.
        </div>
      </header>

      <section style={statRow}>
        <Stat label="Tracked traders" value={String(d.trackedCount)} />
        <Stat label="Events (24h)" value={String(eventCount24h)} />
        <Stat label="Orders (24h)" value={String(orderCount24h)} sub={d.executor === 'dry-run' ? 'dry-run only' : `live: ${d.executor}`} />
        <Stat label="Executor" value={d.executor} sub={`${d.maxLeverage}× max · $${d.maxNotional}/pos`} />
        <Stat label="Follower capital" value={`$${d.followerCapital.toLocaleString()}`} />
      </section>

      <section style={section}>
        <h2 style={h2}>Tracked traders ({d.tracked.length})</h2>
        {d.tracked.length === 0 ? (
          <EmptyState>
            No tracked traders. Seed the queue from psql:{' '}
            <code style={code}>INSERT INTO tracked_traders (platform, trader_key) VALUES (...)</code>
          </EmptyState>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Platform</th>
                <th style={th}>Trader</th>
                <th style={thRight}>Open</th>
                <th style={thRight}>Total Notional</th>
                <th style={thRight}>Last polled</th>
                <th style={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {d.tracked.map((t) => (
                <tr key={`${t.platform}:${t.trader_key}`} style={tr}>
                  <td style={td}>{t.platform}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    <Link href={`/superforecasters/trader/${t.platform}/${encodeURIComponent(t.trader_key)}`}
                      style={{ color: '#5e9eff', textDecoration: 'none' }}>
                      {shortKey(t.trader_key)}
                    </Link>
                  </td>
                  <td style={tdRight}>{t.open_positions}</td>
                  <td style={tdRight}>
                    {t.total_notional != null && t.total_notional > 0
                      ? `$${Math.round(t.total_notional).toLocaleString()}`
                      : '—'}
                  </td>
                  <td style={{ ...tdRight, color: '#9aa', fontSize: 12 }}>{relTime(t.last_polled)}</td>
                  <td style={{ ...td, color: '#9aa', fontSize: 12 }}>{t.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={section}>
        <h2 style={h2}>Recent position changes (last 50)</h2>
        {d.changes.length === 0 ? (
          <EmptyState>No events yet. Run <code style={code}>GET /api/cron/poll-positions</code>.</EmptyState>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Platform</th>
                <th style={th}>Trader</th>
                <th style={th}>Symbol</th>
                <th style={th}>Type</th>
                <th style={thRight}>Side</th>
                <th style={thRight}>Size</th>
                <th style={thRight}>Notional</th>
                <th style={thRight}>Δsize</th>
              </tr>
            </thead>
            <tbody>
              {d.changes.map((c) => (
                <tr key={c.id} style={tr}>
                  <td style={{ ...td, color: '#9aa', fontSize: 12 }}>{relTime(c.detected_at)}</td>
                  <td style={td}>{c.platform}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {shortKey(c.trader_key)}
                  </td>
                  <td style={td}>{c.symbol}</td>
                  <td style={{ ...td, color: typeColor(c.change_type) }}>{c.change_type}</td>
                  <td style={{ ...tdRight, color: c.new_side === 'long' ? '#7fd97f' : c.new_side === 'short' ? '#ff8888' : '#9aa' }}>
                    {c.new_side ?? c.prev_side ?? '—'}
                  </td>
                  <td style={tdRight}>{c.new_size != null ? Number(c.new_size).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}</td>
                  <td style={tdRight}>
                    {c.new_notional != null ? `$${Math.round(c.new_notional).toLocaleString()}` : '—'}
                  </td>
                  <td style={{ ...tdRight, color: (c.size_delta_pct ?? 0) > 0 ? '#7fd97f' : '#ff8888' }}>
                    {c.size_delta_pct != null ? `${c.size_delta_pct >= 0 ? '+' : ''}${c.size_delta_pct.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={section}>
        <h2 style={h2}>Dry-run orders (last 50)</h2>
        {d.orders.length === 0 ? (
          <EmptyState>No orders yet. Run <code style={code}>GET /api/cron/copy-trade-tick</code>.</EmptyState>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Follower</th>
                <th style={th}>Symbol</th>
                <th style={thRight}>Side</th>
                <th style={th}>Intent</th>
                <th style={thRight}>Notional</th>
                <th style={thRight}>Lev</th>
              </tr>
            </thead>
            <tbody>
              {d.orders.map((o) => (
                <tr key={o.id} style={tr}>
                  <td style={{ ...td, color: '#9aa', fontSize: 12 }}>{relTime(o.submitted_at)}</td>
                  <td style={td}>{o.follower}</td>
                  <td style={td}>{o.symbol}</td>
                  <td style={{ ...tdRight, color: o.side === 'long' ? '#7fd97f' : '#ff8888' }}>{o.side}</td>
                  <td style={td}>{o.intent}</td>
                  <td style={tdRight}>${Math.round(o.target_notional_usd).toLocaleString()}</td>
                  <td style={tdRight}>{o.leverage}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────

function shortKey(k: string) {
  if (k.startsWith('0x') && k.length > 14) return `${k.slice(0, 8)}…${k.slice(-6)}`
  if (k.length > 14) return `${k.slice(0, 8)}…${k.slice(-4)}`
  return k
}

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const diffMs = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function typeColor(t: PositionChange['change_type']): string {
  switch (t) {
    case 'opened': return '#7fd97f'
    case 'closed': return '#ff8888'
    case 'resized': return '#dccd7f'
    case 'flipped': return '#5e9eff'
  }
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={statBox}>
      <div style={{ fontSize: 11, color: '#9aa', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 22, color: '#e8e8e8', marginTop: 2, fontWeight: 500 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#778', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#778', fontSize: 13, padding: '12px 0' }}>{children}</div>
}

const section: React.CSSProperties = { marginBottom: 32 }
const h2: React.CSSProperties = { fontSize: 14, fontWeight: 500, color: '#cdd', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.06em' }
const statRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 28 }
const statBox: React.CSSProperties = { border: '1px solid #2a2a2e', borderRadius: 8, padding: '14px 16px', background: '#15151a' }
const table: React.CSSProperties = { borderCollapse: 'collapse', width: '100%', fontSize: 13 }
const th: React.CSSProperties = { padding: '8px 12px', fontWeight: 500, color: '#aab', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #2a2a2e', textAlign: 'left' }
const thRight: React.CSSProperties = { ...th, textAlign: 'right' }
const tr: React.CSSProperties = { borderBottom: '1px solid #1a1a1e' }
const td: React.CSSProperties = { padding: '8px 12px' }
const tdRight: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const code: React.CSSProperties = { background: '#1a1a1e', padding: '2px 6px', borderRadius: 4, fontFamily: 'ui-monospace, monospace', fontSize: 11 }

/**
 * Backfill true Hyperliquid trade count for traders with trades_count = 500
 * (the saturation value from the capped userFills endpoint).
 *
 * These traders all get the same σ² in empirical-Bayes shrinkage even though
 * some have 10× the evidence. This script fetches the true all-time fill count
 * by paginating userFillsByTime from epoch 0 and writes it to
 * trader_stats_detail.total_trades + trader_snapshots_v2.trades_count.
 *
 * Usage:
 *   npx tsx scripts/backfill-hl-trade-count.ts [--dry-run] [--limit N]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='))
const MAX_TRADERS = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1]) : 200
const CONCURRENCY = 3
const PAGE_SIZE = 2000
const MAX_FILLS = 10000

interface HlFill {
  time?: number
  closedPnl?: string
}

async function fetchAllTimeFillCount(address: string): Promise<number> {
  let total = 0
  let startTime = 0

  while (total < MAX_FILLS) {
    let batch: HlFill[] = []
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: address, startTime }),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        console.warn(`  HTTP ${res.status} for ${address}`)
        break
      }
      const raw = await res.json()
      batch = Array.isArray(raw) ? raw : []
    } catch (err) {
      console.warn(`  Fetch error for ${address}: ${err}`)
      break
    }

    total += batch.length
    if (batch.length < PAGE_SIZE) break

    const lastTime = batch[batch.length - 1]?.time
    if (!lastTime) break
    startTime = lastTime + 1

    // Rate-limit: brief pause between pages
    await new Promise(r => setTimeout(r, 300))
  }

  return Math.min(total, MAX_FILLS)
}

async function main() {
  console.log(`Backfilling HL trade counts (dry_run=${DRY_RUN}, max_traders=${MAX_TRADERS})`)

  // Find hyperliquid traders whose most recent stats row has total_trades = 500
  // (or whose snapshots show trades_count = 500 which is the saturation cap)
  const { data: rows, error } = await supabase
    .from('trader_stats_detail')
    .select('source_trader_id, total_trades, captured_at')
    .eq('source', 'hyperliquid')
    .eq('total_trades', 500)
    .order('captured_at', { ascending: false })
    .limit(MAX_TRADERS * 3)  // fetch extra to dedup

  if (error) {
    console.error('Query failed:', error.message)
    process.exit(1)
  }

  // Dedup to one row per trader (most recent)
  const seen = new Set<string>()
  const targets: string[] = []
  for (const row of rows ?? []) {
    const addr = row.source_trader_id.toLowerCase()
    if (!seen.has(addr)) {
      seen.add(addr)
      targets.push(addr)
      if (targets.length >= MAX_TRADERS) break
    }
  }

  console.log(`Found ${targets.length} traders with trades_count = 500`)

  let updated = 0
  let unchanged = 0

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async (addr) => {
      const trueCount = await fetchAllTimeFillCount(addr)
      console.log(`  ${addr}: ${trueCount} fills (was 500)`)

      if (DRY_RUN) return

      if (trueCount <= 500) {
        unchanged++
        return  // Not saturated after all; skip
      }

      // Update trader_stats_detail (most recent row for this trader)
      const { error: err1 } = await supabase
        .from('trader_stats_detail')
        .update({ total_trades: trueCount })
        .eq('source', 'hyperliquid')
        .eq('source_trader_id', addr)
        .eq('total_trades', 500)

      if (err1) {
        console.warn(`  stats_detail update failed for ${addr}: ${err1.message}`)
      }

      // Update trader_snapshots_v2 directly for all windows
      const { error: err2 } = await supabase
        .from('trader_snapshots_v2')
        .update({ trades_count: trueCount })
        .eq('source', 'hyperliquid')
        .eq('source_trader_id', addr)
        .eq('trades_count', 500)

      if (err2) {
        console.warn(`  snapshots_v2 update failed for ${addr}: ${err2.message}`)
      }

      updated++
    }))

    // Brief pause between batches
    if (i + CONCURRENCY < targets.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  console.log(`\nDone. updated=${updated}, unchanged=${unchanged}, dry_run=${DRY_RUN}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

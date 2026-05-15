/**
 * Pure-function diff between two snapshots of a trader's positions. Returns
 * the set of (opened | resized | closed | flipped) events. The worker is
 * responsible for *applying* these events (writing position_changes rows and
 * updating trader_positions); this module just describes them.
 */

import type { Position } from './types'

export type ChangeType = 'opened' | 'resized' | 'closed' | 'flipped'

export interface PositionChange {
  symbol: string
  changeType: ChangeType
  prev: Pick<Position, 'side' | 'size' | 'entryPrice'> | null
  next: Pick<Position, 'side' | 'size' | 'entryPrice' | 'notionalUsd'> | null
  sizeDeltaPct: number | null
}

const RESIZE_THRESHOLD_PCT = 1.0  // ignore <1% size wobble (mark-price noise)

export function diffPositions(prev: Position[], next: Position[]): PositionChange[] {
  const prevMap = new Map(prev.map((p) => [p.symbol, p]))
  const nextMap = new Map(next.map((p) => [p.symbol, p]))

  const symbols = new Set<string>([...prevMap.keys(), ...nextMap.keys()])
  const changes: PositionChange[] = []

  for (const sym of symbols) {
    const p = prevMap.get(sym) ?? null
    const n = nextMap.get(sym) ?? null

    if (!p && n) {
      changes.push({
        symbol: sym,
        changeType: 'opened',
        prev: null,
        next: pick(n),
        sizeDeltaPct: null,
      })
      continue
    }
    if (p && !n) {
      changes.push({
        symbol: sym,
        changeType: 'closed',
        prev: pickPrev(p),
        next: null,
        sizeDeltaPct: -100,
      })
      continue
    }
    if (p && n) {
      if (p.side !== n.side) {
        changes.push({
          symbol: sym,
          changeType: 'flipped',
          prev: pickPrev(p),
          next: pick(n),
          sizeDeltaPct: null,
        })
        continue
      }
      const deltaPct = p.size > 0 ? ((n.size - p.size) / p.size) * 100 : null
      if (deltaPct != null && Math.abs(deltaPct) >= RESIZE_THRESHOLD_PCT) {
        changes.push({
          symbol: sym,
          changeType: 'resized',
          prev: pickPrev(p),
          next: pick(n),
          sizeDeltaPct: round2(deltaPct),
        })
      }
    }
  }

  return changes
}

function pick(p: Position) {
  return { side: p.side, size: p.size, entryPrice: p.entryPrice, notionalUsd: p.notionalUsd }
}
function pickPrev(p: Position) {
  return { side: p.side, size: p.size, entryPrice: p.entryPrice }
}
function round2(x: number) {
  return Math.round(x * 100) / 100
}

/**
 * Public read of recent position changes for tracked traders. Same auth
 * model as /api/top-traders (Bearer BOT_API_KEY; open in dev).
 *
 *   GET /api/position-changes?since_minutes=60&platform=hyperliquid&limit=200
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'

export const dynamic = 'force-dynamic'

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.BOT_API_KEY
  if (!expected) return true
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header
  return timingSafeEq(presented, expected)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const sinceMinutes = Math.min(Math.max(parseInt(params.get('since_minutes') ?? '60', 10), 1), 24 * 60 * 7)
  const limit = Math.min(Math.max(parseInt(params.get('limit') ?? '200', 10), 1), 1000)
  const platform = params.get('platform')
  const traderKey = params.get('trader_key')

  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString()

  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('position_changes')
    .select('*')
    .gte('detected_at', since)
    .order('detected_at', { ascending: false })
    .limit(limit)

  if (platform) query = query.eq('platform', platform)
  if (traderKey) query = query.eq('trader_key', traderKey)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    since_minutes: sinceMinutes,
    count: data?.length ?? 0,
    changes: data ?? [],
  })
}

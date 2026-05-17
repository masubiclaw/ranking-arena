/**
 * GET /api/top-traders — 308 redirect to /api/v1/top-traders.
 *
 * Legacy path kept for one release per CRYAA-2116 D5. Preserves the original
 * query string so existing ACP clients continue to work while they migrate.
 * Logs a deprecation warning per request so we can spot late callers.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const DEPRECATION_SUNSET = 'Wed, 31 Dec 2025 23:59:59 GMT'

export function GET(request: NextRequest) {
  const url = new URL(request.url)
  const target = new URL(`/api/v1/top-traders${url.search}`, url)

  logger.warn('[/api/top-traders] deprecated path used — redirecting to /api/v1/top-traders', {
    ua: request.headers.get('user-agent') || 'unknown',
    referer: request.headers.get('referer') || 'unknown',
  })

  const res = NextResponse.redirect(target, 308)
  res.headers.set('Deprecation', 'true')
  res.headers.set('Sunset', DEPRECATION_SUNSET)
  res.headers.set('Link', '</api/v1/top-traders>; rel="successor-version"')
  return res
}

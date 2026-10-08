import { NextResponse } from 'next/server'
import { getOrCreateSessionId } from '@/lib/session'
import { getUsageSummary } from '@/lib/usage'
import { getTodayLimitStatus } from '@/lib/usage-limits'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/usage — usage summary for the current session (owner-scoped).
 * Light metering surface: totals per kind, last-30d per kind, latest 20 events,
 * PLUS today's soft-limit status per kind (used/cap/remaining/resetAt) so the
 * UI can show meters and warn before a friendly 429. This is the local-mode
 * read side of what becomes plan limits / billing later.
 */
export async function GET() {
  try {
    const ownerId = await getOrCreateSessionId()
    const [summary, limits] = await Promise.all([getUsageSummary(ownerId), getTodayLimitStatus(ownerId)])
    return NextResponse.json({ ...summary, limits })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { getOrCreateSessionId } from '@/lib/session'
import { getUsageSummary } from '@/lib/usage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/usage — usage summary for the current session (owner-scoped).
 * Light metering surface: totals per kind, last-30d per kind, latest 20 events.
 * This is the local-mode read side of what becomes plan limits / billing later.
 */
export async function GET() {
  try {
    const ownerId = await getOrCreateSessionId()
    const summary = await getUsageSummary(ownerId)
    return NextResponse.json(summary)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

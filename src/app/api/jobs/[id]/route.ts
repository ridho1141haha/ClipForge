import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/jobs/[id] — poll an async job (owner-scoped).
 * Returns { job } with status: QUEUED | DOWNLOADING | TRANSCRIBING | COMPLETED | FAILED
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const job = await db.sourceJob.findUnique({ where: { id } })
    if (!job || job.ownerId !== ownerId) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }
    return NextResponse.json({
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        projectId: job.projectId,
        result: job.result ? JSON.parse(job.result) : null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

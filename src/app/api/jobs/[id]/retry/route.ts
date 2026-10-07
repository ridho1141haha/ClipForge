import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { checkRateLimit, rateLimitHeaders } from '@/lib/validation'
import { checkDailyUsageLimit, limitHeaders, limitReachedMessage } from '@/lib/usage-limits'
import { runPrepareJob } from '@/lib/jobs/prepare-worker'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

interface RetryBody {
  /** allow overriding/adding the manual duration on retry (e.g. first attempt failed on missing duration) */
  manualDuration?: number
  /** allow supplying a manual transcript on retry when captions are unavailable */
  manualTranscript?: string
}

/**
 * POST /api/jobs/:id/retry — retry a FAILED prepare job.
 *
 * Job architecture (P1): jobs are persistent rows, so a failed acquisition
 * (typically transient YouTube bot-blocking) can be re-run without losing the
 * pipeline position. The original request payload was persisted on the job row
 * at creation time; optional overrides (manualDuration / manualTranscript) can
 * be merged in for the retry attempt.
 *
 * Retry semantics:
 *   - only FAILED prepare jobs are retryable (transcribe media is ephemeral — re-upload instead)
 *   - the SAME job row is re-used (retryCount kept in errorMessage history via stage text)
 *   - state resets to QUEUED and the worker re-runs from the metadata stage
 *     (already-persisted artifacts like the linked project are re-used, not duplicated)
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`job-retry:${ip}`, 12, 60_000)
  const headers = rateLimitHeaders(rl, 12)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers })
  }
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const job = await db.sourceJob.findUnique({ where: { id } })
    if (!job || job.ownerId !== ownerId) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404, headers })
    }
    if (job.type !== 'prepare') {
      return NextResponse.json(
        { error: 'Only prepare jobs are retryable. For uploads, please upload the file again (media is not kept on the server).' },
        { status: 400, headers },
      )
    }
    if (job.status !== 'FAILED') {
      return NextResponse.json({ error: `Job is ${job.status}, not FAILED — only failed jobs can be retried` }, { status: 409, headers })
    }

    // ---------- daily soft limit (a retry is real engine work — metered) ----------
    const daily = await checkDailyUsageLimit(ownerId, 'prepare')
    if (!daily.allowed) {
      return NextResponse.json(
        { error: limitReachedMessage({ ...daily, kind: 'prepare' }), code: 'DAILY_LIMIT_REACHED', kind: 'prepare', used: daily.used, cap: daily.cap, resetAt: daily.resetAt },
        { status: 429, headers: { ...headers, ...limitHeaders(daily) } },
      )
    }

    const body = (await req.json().catch(() => ({}))) as RetryBody

    // rebuild payload: persisted original + optional overrides
    let base: Record<string, unknown> = {}
    try {
      base = job.payload ? (JSON.parse(job.payload) as Record<string, unknown>) : {}
    } catch {
      base = {}
    }
    const url = String(base.url ?? '')
    if (!url) {
      return NextResponse.json({ error: 'Job payload has no URL — cannot retry. Please start a new prepare job.' }, { status: 400, headers })
    }
    // if the original job linked a project that has since been deleted, drop the link (worker will create a fresh project)
    let projectId = typeof base.projectId === 'string' ? base.projectId : undefined
    if (projectId) {
      const p = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
      if (!p) projectId = undefined
    }
    const manualDuration = isFinite(Number(body.manualDuration)) && Number(body.manualDuration) > 0
      ? Number(body.manualDuration)
      : isFinite(Number(base.manualDuration)) && Number(base.manualDuration) > 0
        ? Number(base.manualDuration)
        : undefined
    const manualTranscript = typeof body.manualTranscript === 'string' && body.manualTranscript.trim()
      ? body.manualTranscript.trim().slice(0, 400_000)
      : typeof base.manualTranscript === 'string'
        ? base.manualTranscript
        : undefined
    const language = typeof base.language === 'string' ? base.language : undefined
    const downloadMedia = base.downloadMedia !== false

    const payload = JSON.stringify({ url, projectId, manualDuration, manualTranscript, language, downloadMedia })
    await db.sourceJob.update({
      where: { id },
      data: {
        status: 'QUEUED',
        stage: 'Retrying…',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        result: null,
        payload,
        projectId: projectId ?? null,
      },
    })

    void runPrepareJob(id, { url, projectId, manualDuration, manualTranscript, language, downloadMedia, ownerId }).catch(() => {})

    return NextResponse.json({ jobId: id, status: 'QUEUED' }, { status: 202, headers })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500, headers })
  }
}

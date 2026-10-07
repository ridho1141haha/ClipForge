import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { checkRateLimit, rateLimitHeaders } from '@/lib/validation'
import { extractYouTubeId } from '@/lib/media'
import { runPrepareJob } from '@/lib/jobs/prepare-worker'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/source/prepare
 * Async job (Phase 19): resolves REAL duration + REAL transcript for a YouTube URL,
 * persisting results into a Project owned by the current session.
 *
 * Body: { url, projectId?, manualDuration?, manualTranscript?, language? }
 * Returns: { jobId } — poll GET /api/jobs/:id
 * Retry: POST /api/jobs/:id/retry (payload is persisted on the job row)
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`prepare:${ip}`, 10, 60_000)
  const headers = rateLimitHeaders(rl, 10)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait a moment before trying again.' },
      { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }
  try {
    const ownerId = await getOrCreateSessionId()
    const body = await req.json().catch(() => ({}))
    const url: string = (body?.url ?? '').trim()
    const projectId: string | undefined = body?.projectId || undefined
    const manualDuration = Number(body?.manualDuration)
    const manualTranscript: string | undefined = typeof body?.manualTranscript === 'string' && body.manualTranscript.trim() ? body.manualTranscript.trim().slice(0, 400_000) : undefined
    const language: string | undefined = body?.language || undefined
    // downloadMedia defaults to true — the download makes the project renderable
    // without a re-upload; callers may opt out explicitly
    const downloadMedia: boolean = body?.downloadMedia !== false

    if (!url || !extractYouTubeId(url)) {
      return NextResponse.json({ error: 'Valid YouTube URL is required' }, { status: 400, headers })
    }

    // verify project ownership when linking to an existing project
    if (projectId) {
      const project = await db.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
      if (!project || project.ownerId !== ownerId) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404, headers })
      }
    }

    // payload persisted → the job can be retried from its failure point later
    const payload = JSON.stringify({ url, projectId, manualDuration: isFinite(manualDuration) && manualDuration > 0 ? manualDuration : undefined, manualTranscript, language, downloadMedia })

    const job = await db.sourceJob.create({
      data: {
        ownerId,
        projectId: projectId ?? null,
        type: 'prepare',
        status: 'QUEUED',
        stage: 'Queued',
        progress: 0,
        payload,
      },
    })

    // fire-and-forget worker (job state persisted in DB)
    void runPrepareJob(job.id, { url, projectId, manualDuration, manualTranscript, language, downloadMedia, ownerId }).catch(() => {})

    return NextResponse.json({ jobId: job.id }, { status: 202, headers })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500, headers })
  }
}

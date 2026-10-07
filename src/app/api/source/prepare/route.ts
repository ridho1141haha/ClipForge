import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { checkRateLimit, rateLimitHeaders } from '@/lib/validation'
import { extractYouTubeId, resolveYoutubeMeta, resolveYoutubeTranscript } from '@/lib/media'

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

    const job = await db.sourceJob.create({
      data: {
        ownerId,
        projectId: projectId ?? null,
        type: 'prepare',
        status: 'QUEUED',
        stage: 'Queued',
        progress: 0,
      },
    })

    // fire-and-forget worker (job state persisted in DB)
    void runPrepareJob(job.id, { url, projectId, manualDuration, manualTranscript, language, ownerId }).catch(() => {})

    return NextResponse.json({ jobId: job.id }, { status: 202, headers })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500, headers })
  }
}

// ---------------------------------------------------------------------------
// Job worker
// ---------------------------------------------------------------------------

async function setJob(id: string, data: { status?: string; stage?: string; progress?: number; errorCode?: string | null; errorMessage?: string | null; result?: string | null; projectId?: string | null }) {
  try {
    await db.sourceJob.update({ where: { id }, data })
  } catch {
    // job row may have been deleted; nothing else to do
  }
}

async function runPrepareJob(
  jobId: string,
  opts: { url: string; projectId?: string; manualDuration?: number; manualTranscript?: string; language?: string; ownerId: string },
) {
  const { url, projectId, ownerId } = opts
  try {
    // ---------- Stage 1: DOWNLOADING (real metadata) ----------
    await setJob(jobId, { status: 'DOWNLOADING', stage: 'Resolving video metadata (yt-dlp → innertube → oEmbed)…', progress: 10 })
    const meta = await resolveYoutubeMeta(url)

    let duration = meta.duration
    let durationSource = meta.durationSource
    if (duration === null) {
      if (opts.manualDuration && isFinite(opts.manualDuration) && opts.manualDuration > 0) {
        duration = Math.round(opts.manualDuration * 10) / 10
        durationSource = 'user-provided'
      }
      // else: stays null — explicit, never faked
    }

    // ---------- Stage 2: TRANSCRIBING (real transcript) ----------
    await setJob(jobId, { status: 'TRANSCRIBING', stage: 'Fetching YouTube captions / transcript…', progress: 45 })
    let transcriptText: string | null = null
    let transcriptWords: string | null = null
    let transcriptSource = 'none'
    let wordTiming: 'measured' | 'estimated' | null = null
    let transcriptError: string | null = null

    const caps = await resolveYoutubeTranscript(meta.youtubeId, opts.language && opts.language !== 'auto' ? `${opts.language},en,id` : 'en,id')
    if (caps) {
      transcriptText = caps.text
      transcriptWords = caps.words.length > 0 ? JSON.stringify(caps.words.slice(0, 60_000)) : null
      transcriptSource = caps.source
      wordTiming = caps.words.length > 0 ? caps.wordTiming : null
    } else {
      transcriptError = 'No captions available via yt-dlp (blocked, disabled, or none exist for this video)'
    }

    if (!transcriptText && opts.manualTranscript) {
      transcriptText = opts.manualTranscript
      transcriptWords = null // manual paste has no word timings
      transcriptSource = 'manual'
      wordTiming = null
      transcriptError = null
    }

    // ---------- Stage 3: persist project ----------
    await setJob(jobId, { status: 'TRANSCRIBING', stage: 'Saving source data…', progress: 80 })

    const projectData = {
      youtubeId: meta.youtubeId,
      url: meta.url,
      title: meta.title,
      author: meta.author,
      thumbnail: meta.thumbnail,
      duration,
      durationSource,
      transcript: transcriptText,
      transcriptWords,
      transcriptSource,
      wordTiming,
      language: opts.language ?? null,
    }

    let project
    if (projectId) {
      const existing = await db.project.findUnique({ where: { id: projectId } })
      if (!existing || existing.ownerId !== ownerId) throw new Error('Project not found or not owned by session')
      project = await db.project.update({ where: { id: projectId }, data: projectData })
    } else {
      project = await db.project.create({ data: { ownerId, ...projectData, status: 'new' } })
    }

    const result = {
      projectId: project.id,
      duration: project.duration,
      durationSource: project.durationSource,
      transcriptSource: project.transcriptSource,
      wordTiming: project.wordTiming,
      transcriptChars: transcriptText?.length ?? 0,
      wordCount: transcriptWords ? (JSON.parse(transcriptWords) as unknown[]).length : 0,
      transcriptError,
      resolverErrors: meta.resolverErrors,
      warnings: [
        ...(duration === null ? ['Real duration unavailable — provide manual duration before analysis.'] : []),
        ...(transcriptSource === 'none' ? ['No transcript available — analysis will run WITHOUT content grounding (hooks unverified).'] : []),
        ...(wordTiming === 'estimated' ? ['Word timestamps are ESTIMATED from segment timings (source has no word-level timing data).'] : []),
      ],
    }
    await setJob(jobId, {
      status: 'COMPLETED',
      stage: 'Source ready',
      progress: 100,
      projectId: project.id,
      errorCode: null,
      errorMessage: null,
      result: JSON.stringify(result),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    await setJob(jobId, {
      status: 'FAILED',
      stage: 'Failed',
      errorCode: 'PREPARE_FAILED',
      errorMessage: message,
    })
  }
}

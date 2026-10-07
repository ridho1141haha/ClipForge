import { db } from '@/lib/db'
import { extractYouTubeId, resolveYoutubeMeta, resolveYoutubeTranscript } from '@/lib/media'
import { recordUsage } from '@/lib/usage'

/**
 * Prepare-job worker (shared by POST /api/source/prepare and POST /api/jobs/:id/retry).
 *
 * Stage model (persisted in SourceJob.status/stage/progress):
 *   QUEUED → DOWNLOADING (metadata) → TRANSCRIBING (captions) → COMPLETED | FAILED
 *
 * Honesty rules preserved here:
 *   - duration: real (yt-dlp → innertube → oEmbed-chain) or user-provided; NEVER guessed
 *   - transcript: real captions (word-timing provenance kept) or manual; NEVER fabricated
 */
export interface PreparePayload {
  url: string
  projectId?: string
  manualDuration?: number
  manualTranscript?: string
  language?: string
  ownerId: string
}

export async function setPrepareJob(
  id: string,
  data: { status?: string; stage?: string; progress?: number; errorCode?: string | null; errorMessage?: string | null; result?: string | null; projectId?: string | null },
) {
  try {
    await db.sourceJob.update({ where: { id }, data })
  } catch {
    // job row may have been deleted; nothing else to do
  }
}

export async function runPrepareJob(jobId: string, opts: PreparePayload) {
  const { url, projectId, ownerId } = opts
  try {
    if (!url || !extractYouTubeId(url)) throw new Error('Valid YouTube URL is required')

    // ---------- Stage 1: DOWNLOADING (real metadata) ----------
    await setPrepareJob(jobId, { status: 'DOWNLOADING', stage: 'Resolving video metadata (yt-dlp → innertube → oEmbed)…', progress: 10 })
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
    await setPrepareJob(jobId, { status: 'TRANSCRIBING', stage: 'Fetching YouTube captions / transcript…', progress: 45 })
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
    await setPrepareJob(jobId, { status: 'TRANSCRIBING', stage: 'Saving source data…', progress: 80 })

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
      youtubeId: project.youtubeId,
      title: project.title,
      author: project.author,
      thumbnail: project.thumbnail,
      duration: project.duration,
      durationSource: project.durationSource,
      transcriptSource: project.transcriptSource,
      wordTiming: project.wordTiming,
      language: project.language,
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
    // usage metering (best-effort, never fails the job)
    void recordUsage(ownerId, 'prepare', 1, { projectId: project.id, transcriptSource })

    await setPrepareJob(jobId, {
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
    await setPrepareJob(jobId, {
      status: 'FAILED',
      stage: 'Failed',
      errorCode: 'PREPARE_FAILED',
      errorMessage: message,
    })
  }
}

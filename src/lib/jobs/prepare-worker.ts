import { db } from '@/lib/db'
import { downloadYoutubeMedia, extractYouTubeId, resolveYoutubeMeta, resolveYoutubeTranscript } from '@/lib/media'
import { pruneMediaCache, touchMediaCache } from '@/lib/media-cache'
import { recordUsage } from '@/lib/usage'

/**
 * Prepare-job worker (shared by POST /api/source/prepare and POST /api/jobs/:id/retry).
 *
 * Stage model (persisted in SourceJob.status/stage/progress):
 *   QUEUED → DOWNLOADING (metadata) → TRANSCRIBING (captions)
 *          → TRANSCRIBING (media download for rendering) → COMPLETED | FAILED
 *
 * Honesty rules preserved here:
 *   - duration: real (yt-dlp → innertube → oEmbed-chain) or user-provided; NEVER guessed
 *   - transcript: real captions (word-timing provenance kept) or manual; NEVER fabricated
 *   - media download failure never fails the job: its primary purpose is
 *     metadata + transcript for analysis. A failed download is persisted as
 *     localMediaState='failed' so the UI can offer the upload path instead.
 */
export interface PreparePayload {
  url: string
  projectId?: string
  manualDuration?: number
  manualTranscript?: string
  language?: string
  /** download the source video so the project can render without an upload (default true) */
  downloadMedia?: boolean
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
    let wordTiming: 'measured' | 'estimated' | 'mixed' | null = null
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

    // ---------- Stage 3: source media download (render-ready project) ----------
    let localMediaState: string | null = null
    let localMediaError: string | null = null
    let localMedia: { relativePath: string; sizeBytes: number; mimeType: string } | null = null
    if (opts.downloadMedia === false) {
      localMediaState = 'skipped'
    } else {
      await setPrepareJob(jobId, {
        status: 'TRANSCRIBING',
        stage: `Downloading source video (yt-dlp, ≤${duration && duration <= 1200 ? 1080 : 720}p) — enables direct rendering…`,
        progress: 60,
      })
      try {
        const dl = await downloadYoutubeMedia(meta.youtubeId, {
          maxHeight: duration && duration <= 1200 ? 1080 : 720,
        })
        localMediaState = 'ready'
        localMedia = { relativePath: dl.relativePath, sizeBytes: dl.sizeBytes, mimeType: dl.mimeType }
        touchMediaCache(meta.youtubeId)
      } catch (e) {
        // NEVER fail the job for a media download problem — analysis still works
        localMediaState = 'failed'
        localMediaError = e instanceof Error ? e.message : 'Download failed'
      }
    }

    // ---------- Stage 4: persist project ----------
    await setPrepareJob(jobId, { status: 'TRANSCRIBING', stage: 'Saving source data…', progress: 90 })

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
      localMedia: localMedia?.relativePath ?? null,
      localMediaSize: localMedia?.sizeBytes ?? null,
      localMediaState,
      localMediaError,
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
      localMedia: localMedia
        ? { state: 'ready' as const, sizeBytes: localMedia.sizeBytes, mimeType: localMedia.mimeType, path: localMedia.relativePath }
        : { state: localMediaState, error: localMediaError },
      warnings: [
        ...(duration === null ? ['Real duration unavailable — provide manual duration before analysis.'] : []),
        ...(transcriptSource === 'none' ? ['No transcript available — analysis will run WITHOUT content grounding (hooks unverified).'] : []),
        ...(wordTiming === 'estimated' ? ['Word timestamps are ESTIMATED from segment timings (source has no word-level timing data).'] : []),
        ...(wordTiming === 'mixed' ? ['Word timestamps are PARTIALLY measured — some words are interpolated from segment timings, so word-precision features (karaoke) may fall back to plain subtitles.'] : []),
        ...(localMediaState === 'failed'
          ? [`Source video could not be downloaded (${localMediaError ?? 'unknown reason'}). You can still analyze — upload the file when rendering.`]
          : []),
      ],
    }
    // usage metering (best-effort, never fails the job)
    void recordUsage(ownerId, 'prepare', 1, { projectId: project.id, transcriptSource })

    // cache hygiene (best-effort, after the download): enforce the LRU cap and
    // honestly mark projects whose cached source was evicted
    try {
      const pruned = pruneMediaCache()
      if (pruned.evicted.length > 0) {
        for (const evictedId of pruned.evicted) {
          await db.project.updateMany({
            where: { youtubeId: evictedId, localMediaState: 'ready' },
            data: { localMediaState: 'unavailable', localMediaError: 'Cached source evicted by media cache policy (least-recently-used). Re-prepare or upload to render.' },
          })
        }
      }
    } catch { /* hygiene must never fail the job */ }

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

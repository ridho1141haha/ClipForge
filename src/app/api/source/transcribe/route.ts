import { NextRequest, NextResponse } from 'next/server'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { checkRateLimit, rateLimitHeaders } from '@/lib/validation'
import { probeMediaDuration } from '@/lib/media'

const execFileAsync = promisify(execFile)

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 800

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500MB

/**
 * POST /api/source/transcribe  (multipart: file, title?, language?)
 * Async job (Phase 19 extension): real ASR on an uploaded video/audio file.
 * ffmpeg extracts 16 kHz mono audio → faster-whisper produces word-level
 * timestamps → everything persists into a Project owned by the session
 * (transcriptSource='asr', duration measured by ffprobe — never guessed).
 * Poll via GET /api/jobs/:id
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`transcribe:${ip}`, 6, 60_000)
  const headers = rateLimitHeaders(rl, 6)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded — transcription is expensive. Please wait a minute.' },
      { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }
  try {
    const ownerId = await getOrCreateSessionId()
    const form = await req.formData()
    const file = form.get('file') as File | null
    const title = String(form.get('title') ?? '').trim()
    const language = String(form.get('language') ?? 'auto').trim()
    const projectId = String(form.get('projectId') ?? '').trim()

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'file (video/audio) is required' }, { status: 400, headers })
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: `File too large (${(file.size / 1048576).toFixed(0)} MB). Max 500 MB.` }, { status: 413, headers })
    }
    const isMedia = file.type.startsWith('video/') || file.type.startsWith('audio/') || /\.(mp4|mov|webm|mkv|avi|m4a|mp3|wav|ogg)$/i.test(file.name)
    if (!isMedia) {
      return NextResponse.json({ error: 'Please upload a video or audio file (MP4, MOV, WebM, M4A, MP3, WAV…)' }, { status: 400, headers })
    }
    if (projectId) {
      const project = await db.project.findFirst({ where: { id: projectId, ownerId }, select: { id: true } })
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404, headers })
    }

    // stage the upload
    const dir = mkdtempSync(join(tmpdir(), 'clipforge-asr-'))
    const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'upload'
    const mediaPath = join(dir, safeName)
    writeFileSync(mediaPath, Buffer.from(await file.arrayBuffer()))

    const job = await db.sourceJob.create({
      data: {
        ownerId,
        projectId: projectId || null,
        type: 'transcribe',
        status: 'QUEUED',
        stage: 'Queued',
        progress: 0,
      },
    })

    void runTranscribeJob(job.id, { mediaPath, dir, title, language, projectId, ownerId, originalName: file.name }).catch(() => {})

    return NextResponse.json({ jobId: job.id }, { status: 202, headers })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500, headers })
  }
}

async function setJob(id: string, data: Record<string, unknown>) {
  try {
    await db.sourceJob.update({ where: { id }, data })
  } catch {
    // job row may be gone
  }
}

async function runTranscribeJob(
  jobId: string,
  opts: { mediaPath: string; dir: string; title: string; language: string; projectId?: string; ownerId: string; originalName: string },
) {
  const { mediaPath, dir, language, projectId, ownerId } = opts
  try {
    // ---------- Stage 1: probe real duration ----------
    await setJob(jobId, { status: 'DOWNLOADING', stage: 'Probing media…', progress: 10 })
    const duration = await probeMediaDuration(mediaPath)
    if (duration === null) {
      throw Object.assign(new Error('Could not read the media file (corrupt or unsupported codec)'), { code: 'MEDIA_UNREADABLE' })
    }

    // ---------- Stage 2: extract audio ----------
    await setJob(jobId, { status: 'DOWNLOADING', stage: 'Extracting 16 kHz mono audio (ffmpeg)…', progress: 25 })
    const wavPath = join(dir, 'audio.wav')
    try {
      await execFileAsync('ffmpeg', ['-nostdin', '-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath], { timeout: 300_000 })
    } catch (e) {
      throw Object.assign(new Error('Audio extraction failed — is this a valid media file?'), { code: 'FFMPEG_FAILED' })
    }

    // ---------- Stage 3: ASR ----------
    await setJob(jobId, { status: 'TRANSCRIBING', stage: 'Running faster-whisper (word-level timestamps)…', progress: 45 })
    const outPath = join(dir, 'asr.json')
    const scriptPath = join(process.cwd(), 'scripts', 'asr-transcribe.py')
    try {
      await execFileAsync('python3', [scriptPath, wavPath, outPath, 'tiny', language], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
    } catch (e) {
      const stderr = (e as { stderr?: string })?.stderr ?? ''
      let msg = 'ASR failed'
      try {
        msg = JSON.parse(stderr.trim().split('\n').pop() ?? '{}').error ?? msg
      } catch { /* keep default */ }
      throw Object.assign(new Error(msg), { code: 'ASR_FAILED' })
    }

    const asr = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(outPath, 'utf-8'))) as {
      text: string
      words: { word: string; start: number; end: number }[]
      language?: string
      model?: string
      elapsed_seconds?: number
    }

    if (!asr.text.trim() && (!asr.words || asr.words.length === 0)) {
      throw Object.assign(new Error('No speech detected in the uploaded media (VAD found no voice activity).'), { code: 'NO_SPEECH' })
    }

    // ---------- Stage 4: persist project ----------
    await setJob(jobId, { status: 'TRANSCRIBING', stage: 'Saving transcript & project…', progress: 85 })
    const title = (opts.title || opts.originalName.replace(/\.[^.]+$/, '') || 'Uploaded media').slice(0, 200)
    const projectData = {
      youtubeId: `upload-${randomUUID().slice(0, 8)}`,
      url: `upload://${opts.originalName}`,
      title,
      author: null,
      thumbnail: null,
      duration,
      durationSource: 'ffprobe' as const,
      transcript: asr.text,
      transcriptWords: JSON.stringify(asr.words.slice(0, 60_000)),
      transcriptSource: 'asr' as const,
      // faster-whisper produces REAL per-word timings (word_timestamps=True)
      wordTiming: 'measured' as const,
      language: asr.language ?? (language !== 'auto' ? language : null),
    }

    let project
    if (projectId) {
      const existing = await db.project.findFirst({ where: { id: projectId, ownerId } })
      if (!existing) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' })
      project = await db.project.update({ where: { id: projectId }, data: projectData })
    } else {
      project = await db.project.create({ data: { ownerId, ...projectData, status: 'new' } })
    }

    // persist ASR model metadata for reproducibility
    await db.project.update({
      where: { id: project.id },
      data: {
        analysisMeta: JSON.stringify({
          asr: { model: asr.model ?? 'tiny', language: asr.language, elapsedSeconds: asr.elapsed_seconds, words: asr.words.length },
        }),
      },
    })

    const result = {
      projectId: project.id,
      title: project.title,
      duration: project.duration,
      durationSource: project.durationSource,
      transcriptSource: project.transcriptSource,
      transcriptChars: asr.text.length,
      wordCount: asr.words.length,
      language: asr.language,
      words: asr.words.slice(0, 20_000), // client grounds analyze immediately (≈2h of speech)
      warnings: [],
    }
    await setJob(jobId, {
      status: 'COMPLETED',
      stage: 'Transcription complete',
      progress: 100,
      projectId: project.id,
      errorCode: null,
      errorMessage: null,
      result: JSON.stringify(result),
    })
  } catch (e) {
    const err = e as Error & { code?: string }
    await setJob(jobId, {
      status: 'FAILED',
      stage: 'Failed',
      errorCode: err.code ?? 'TRANSCRIBE_FAILED',
      errorMessage: err.message,
    })
  } finally {
    // cleanup temp media
    try { rmSync(opts.dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

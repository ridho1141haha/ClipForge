// ClipForge AI — ffmpeg render mini-service (port 3003)
// Accepts multipart upload: video file + JSON recipe
// Renders MP4 with cuts, subtitle burn-in, camera zoom via ffmpeg
// Exposes: POST /render (start job), GET /jobs/:id (poll status), GET /jobs/:id/stream (SSE), GET /jobs/:id/download
//
// ─── NETWORK BOUNDARY (security invariant) ──────────────────────────────────
// This service is INTERNAL and TRUSTED. It performs NO authorization of its
// own — ownership is enforced by the Next.js proxy (render-proxy route),
// which is the ONLY supported client:
//
//   Browser → Next.js authorization (session + RenderJob ownership) →
//   localhost renderer (127.0.0.1:3003) → FFmpeg
//
// The server is explicitly bound to 127.0.0.1 (Bun's documented default is
// 0.0.0.0, which would expose /render + job endpoints to the network).
// Never bind it to a public interface without adding internal auth first.
// If a deployment ever needs a remote renderer, add explicit shared-secret
// auth on BOTH sides and document the architecture in SECURITY.md.
//
// CORS: deliberately NONE. CORS is a browser-enforced mechanism; this service
// has exactly one supported client — the Next.js proxy — which communicates
// server-to-server (fetch does not enforce CORS). Emitting wildcard
// Access-Control-* headers here would only ever AUTHORIZE browser pages to
// read a trusted internal service. Browsers must go through Next.js.

import { serve } from 'bun'
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { validateRecipe, RECIPE_LIMITS, type ValidatedRecipe } from './recipe-validation'

const PORT = 3003
const WORKDIR = '/home/z/my-project/upload/ffmpeg-render'
if (!existsSync(WORKDIR)) mkdirSync(WORKDIR, { recursive: true })

// ---- Job state machine (deterministic transitions; mission Phase 6) ----
//   QUEUED → EXTRACTING → RENDERING → FINALIZING → DONE
//   any active state → CANCELLED (explicit user action, kills ffmpeg)
//   any active state → ERROR
//   terminal states (DONE/ERROR/CANCELLED) are final — a cancelled job can
//   NEVER later become RUNNING/COMPLETED again.
type JobStatus = RenderJob['status']
const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['extracting', 'cancelled', 'error'],
  extracting: ['rendering', 'cancelled', 'error'],
  rendering: ['finalizing', 'cancelled', 'error'],
  finalizing: ['done', 'cancelled', 'error'],
  done: [],
  error: [],
  cancelled: [],
}
function transition(job: RenderJob, next: JobStatus): boolean {
  if (!ALLOWED_TRANSITIONS[job.status]?.includes(next)) return false
  job.status = next
  return true
}
function isActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'extracting' || status === 'rendering' || status === 'finalizing'
}

// ---- Job registry (in-memory) ----
interface RenderJob {
  id: string
  status: 'queued' | 'extracting' | 'concatenating' | 'rendering' | 'finalizing' | 'done' | 'error' | 'cancelled'
  progress: number // 0-100
  stage: string // human-readable stage
  filename?: string
  size?: number
  duration?: number
  width?: number
  height?: number
  /** false when rendered duration deviates from the recipe beyond tolerance */
  durationOk?: boolean
  /** true when a cover-frame JPG was extracted from the OUTPUT at recipe.cover.timestamp */
  hasCover?: boolean
  error?: string
  createdAt: number
  finishedAt?: number
  recipeDuration: number // per-job (fixes the cross-job race)
  // currently running child process (for cancel)
  currentChild?: ReturnType<typeof spawn> | null
  // SSE subscribers
  subscribers: Set<(data: string) => void>
}

const jobs = new Map<string, RenderJob>()

function timeToFFmpeg(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(si)}.${p(ms, 3)}`
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)
}

function buildZoompanFilter(recipe: ValidatedRecipe, fps = 30): string | null {
  const kfs = recipe.camera_keyframes ?? []
  if (!kfs || kfs.length < 2) return null
  const rawFrames = Math.round((recipe.duration ?? 10) * fps)
  // NaN/absurd-duration guard: recipe.duration is validated finite, but this
  // filter must never emit a broken zoompan expression regardless.
  if (!Number.isFinite(rawFrames) || rawFrames <= 0) return null
  const totalFrames = Math.max(1, Math.min(rawFrames, RECIPE_LIMITS.MAX_OUTPUT_DURATION * fps))
  const sortedKfs = [...kfs].sort((a, b) => a.time - b.time)
  const scales: number[] = []
  // keyframes are OUTPUT-time: frame f → output time f/fps directly
  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps
    scales.push(scaleAtTime(t, sortedKfs))
  }
  const maxScale = Math.max(...scales, 1)
  const minScale = Math.min(...scales, 1)
  if (Math.abs(maxScale - minScale) < 0.01) return null
  const step = Math.max(1, Math.floor(totalFrames / 20))
  const samples: { frame: number; scale: number }[] = []
  for (let f = 0; f < totalFrames; f += step) samples.push({ frame: f, scale: scales[f] })
  samples.push({ frame: totalFrames, scale: scales[totalFrames - 1] })
  let expr = samples[samples.length - 1].scale.toFixed(3)
  for (let i = samples.length - 2; i >= 0; i--) {
    expr = `if(lt(on,${samples[i].frame}),${samples[i].scale.toFixed(3)},${expr})`
  }
  return `zoompan=z='${expr}':d=1:s=1080x1920:fps=${fps}`
}

function scaleAtTime(time: number, sorted: { time: number; scale: number }[]): number {
  if (sorted.length === 0) return 1
  if (time <= sorted[0].time) return sorted[0].scale
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].scale
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].time <= time && sorted[i + 1].time >= time) {
      const t = (time - sorted[i].time) / (sorted[i + 1].time - sorted[i].time)
      return sorted[i].scale + (sorted[i + 1].scale - sorted[i].scale) * t
    }
  }
  return 1
}

/** Log a completed stage with its wall duration (observability, mission Phase 12). */
function stageTiming(job: RenderJob, label: string, startedAt: number) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[${job.id}] stage "${label}" done in ${secs}s`)
}

// Run a command, capturing output for progress parsing.
// Includes a hard timeout — a hung ffmpeg must never hang the job forever.
// When opts.progressPipe is set, `-progress pipe:1 -nostats` is appended and
// stdout's machine-readable `out_time_us=` lines drive smooth, regular progress
// updates (stderr time= parsing stays as a fallback for other commands).
function run(
  cmd: string[],
  cwd: string,
  job: RenderJob,
  stageLabel: string,
  stageStart: number,
  stageEnd: number,
  timeoutMs = 15 * 60_000,
  opts?: { progressPipe?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // -progress/-nostats are GLOBAL options: they must precede input/output
    // URLs (verified: appended after the output file emits nothing on stdout).
    const args = opts?.progressPipe
      ? [cmd[0], cmd[1] ?? '-nostdin', '-progress', 'pipe:1', '-nostats', ...cmd.slice(2)]
      : cmd
    const p = spawn(args[0], args.slice(1), { cwd })
    job.currentChild = p
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { p.kill('SIGKILL') } catch {}
    }, timeoutMs)

    const reportTime = (sec: number) => {
      const totalForStage = Math.max(1, job.recipeDuration || 10)
      const stageProgress = Math.min(1, sec / totalForStage)
      const overall = stageStart + stageProgress * (stageEnd - stageStart)
      job.progress = Math.round(overall)
      job.stage = stageLabel
      broadcast(job)
    }

    p.stdout.on('data', (d) => {
      const text = d.toString()
      stdout += text
      if (opts?.progressPipe) {
        // -progress pipe:1 emits key=value blocks at a regular cadence
        const m = text.match(/out_time_us=(\d+)/) || text.match(/out_time_ms=(\d+)/)
        if (m) {
          const us = parseInt(m[1], 10)
          // legacy caveat: some ffmpeg builds emit microseconds in out_time_ms
          const sec = m[0].startsWith('out_time_us') ? us / 1_000_000 : us / 1_000_000
          if (isFinite(sec) && sec >= 0) reportTime(sec)
        }
      }
    })
    p.stderr.on('data', (d) => {
      const text = d.toString()
      stderr += text
      // Fallback parse: time=00:00:05.12 → progress within stage
      if (opts?.progressPipe) return // stdout is authoritative in progress-pipe mode
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m) {
        const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        reportTime(sec)
      }
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      job.currentChild = null
      resolve({ code: timedOut ? -2 : (code ?? -1), stdout, stderr: timedOut ? stderr + `\n[clipforge] command timed out after ${timeoutMs}ms` : stderr })
    })
  })
}

/** True when the input file has at least one audio stream. */
async function probeHasAudio(filePath: string): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', filePath],
      { timeout: 15_000 },
    )
    const streams = JSON.parse(stdout)?.streams ?? []
    return Array.isArray(streams) && streams.length > 0
  } catch {
    return false
  }
}

function broadcast(job: RenderJob) {
  const payload = JSON.stringify({
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    error: job.error,
    filename: job.filename,
    size: job.size,
    duration: job.duration,
    width: job.width,
    height: job.height,
    durationOk: job.durationOk,
    hasCover: job.hasCover,
  })
  for (const send of job.subscribers) {
    try { send(`data: ${payload}\n\n`) } catch {}
  }
}

function publicJob(job: RenderJob) {
  const { subscribers, ...rest } = job
  return rest
}

async function processJob(jobId: string, file: File, recipe: ValidatedRecipe) {
  const job = jobs.get(jobId)!
  const jobStart = Date.now()
  // job dir lives in the OUTER scope so the finally-cleanup covers every
  // terminal outcome (success / error / cancel / early return)
  const jobDir = join(WORKDIR, jobId)
  try {
    mkdirSync(jobDir, { recursive: true })
    const inputPath = join(jobDir, 'input' + (file.name.match(/\.[a-z0-9]+$/)?.[0] ?? '.mp4'))
    // Bun.write streams the Blob to disk without materializing it a second time
    // in the JS heap (the old arrayBuffer() path held up to 1.5 GB in RAM).
    await Bun.write(inputPath, file)
    const inSize = statSync(inputPath).size
    console.log(`[${jobId}] received ${file.name} (${inSize} bytes)`)
    job.recipeDuration = recipe.duration

    // keep_ranges are REQUIRED and validated — no silent full-clip fallback.
    // (The old fallback rendered the FULL window when keep_ranges was empty,
    // turning a fully-cut edit into a phantom full video.)
    const ranges = recipe.keep_ranges

    // Probe the input ONCE: does it have audio? This decides the render path —
    // we NEVER mask a failed render with a silent-audio retry (that produced
    // silent videos for unrelated failures).
    const inputHasAudio = await probeHasAudio(inputPath)
    if (!inputHasAudio) {
      job.stage = 'Source has no audio stream — rendering with silent track'
      broadcast(job)
    }

    // Stage 1-3 (single accurate pass): trim keep ranges → concat → burn subs → zoom → 9:16
    // Frame-accurate: filter_complex trim/atrim (NOT -c copy, which snaps to keyframes
    // and desynchronizes output duration from the edit plan).
    if (!transition(job, 'extracting')) return // cancelled while queued
    const extractingStart = Date.now()
    job.stage = `Preparing ${ranges.length} keep range${ranges.length === 1 ? '' : 's'} (frame-accurate trim)…`
    job.progress = 8
    broadcast(job)

    if (recipe.subtitles_ass) writeFileSync(join(jobDir, 'subs.ass'), recipe.subtitles_ass)

    // build filter_complex
    // FILTER ORDER (fixed): scale/crop to 9:16 FIRST (no aspect distortion),
    // then zoompan punches into the already-vertical frame, then subtitles are
    // burned LAST so they stay fixed-size and are never cropped by the zoom.
    const fcParts: string[] = []
    ranges.forEach((r, i) => {
      fcParts.push(`[0:v]trim=start=${Number(r.start).toFixed(3)}:end=${Number(r.end).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`)
      if (inputHasAudio) {
        fcParts.push(`[0:a]atrim=start=${Number(r.start).toFixed(3)}:end=${Number(r.end).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
      } else {
        fcParts.push(`[1:a]atrim=start=${Number(r.start).toFixed(3)}:end=${Number(r.end).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
      }
    })
    const concatIn = ranges.map((_, i) => `[v${i}][a${i}]`).join('')
    fcParts.push(`${concatIn}concat=n=${ranges.length}:v=1:a=1[vc][ac]`)
    const postParts: string[] = []
    postParts.push('scale=1080:1920:force_original_aspect_ratio=increase')
    postParts.push('crop=1080:1920')
    const zoom = buildZoompanFilter(recipe)
    if (zoom) postParts.push(zoom)
    if (recipe.subtitles_ass) postParts.push(`ass='${join(jobDir, 'subs.ass')}'`)
    fcParts.push(`[vc]${postParts.join(',')}[vf]`)

    stageTiming(job, 'prepare', extractingStart)
    if (!transition(job, 'rendering')) return // cancelled during prep
    const renderingStart = Date.now()
    job.stage = `Rendering: trim+concat+${postParts.length} filters (single pass)…`
    job.progress = 25
    broadcast(job)

    const outName = `clipforge_${sanitize(recipe.title ?? 'clip')}.mp4`
    const outPath = join(jobDir, outName)

    let finalRes: { code: number; stdout: string; stderr: string }
    if (job.status === 'cancelled') return // cancelled before render started
    if (inputHasAudio) {
      const args = ['ffmpeg', '-nostdin', '-y', '-i', inputPath, '-filter_complex', fcParts.join(';'), '-map', '[vf]', '-map', '[ac]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-r', '30', outPath]
      finalRes = await run(args, jobDir, job, 'Encoding H.264 + burning subtitles + zoom', 25, 92, 15 * 60_000, { progressPipe: true })
      if (job.status === 'cancelled') return
      if (finalRes.code !== 0) {
        throw new Error('ffmpeg render failed: ' + finalRes.stderr.slice(-600))
      }
    } else {
      // no source audio → use anullsrc silence for the audio chain (single attempt)
      if (job.status === 'cancelled') return
      const silentArgs = [
        'ffmpeg', '-nostdin', '-y',
        '-i', inputPath,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-filter_complex', fcParts.join(';'),
        '-map', '[vf]', '-map', '[ac]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-r', '30',
        '-shortest', outPath,
      ]
      finalRes = await run(silentArgs, jobDir, job, 'Encoding (silent audio — source has no audio)', 25, 92, 15 * 60_000, { progressPipe: true })
      if (job.status === 'cancelled') return
      if (finalRes.code !== 0) {
        throw new Error('ffmpeg render failed (silent-audio path): ' + finalRes.stderr.slice(-600))
      }
    }

    stageTiming(job, 'render', renderingStart)
    if (!transition(job, 'finalizing')) return // cancelled during encode
    const finalizeStart = Date.now()
    job.stage = 'Finalizing…'
    job.progress = 95
    broadcast(job)

    // cleanup intermediates
    try { rmSync(join(jobDir, 'subs.ass')) } catch {}
    try { rmSync(inputPath) } catch {}

    const stat = statSync(outPath)
    job.size = stat.size
    job.filename = outName
    // probe duration + dimensions + codecs — a failed codec check MUST fail the job
    const probeRes = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name,codec_type', '-of', 'json', outPath], jobDir, job, 'Finalizing', 95, 99, 30_000)
    const probe = JSON.parse(probeRes.stdout)
    job.duration = parseFloat(probe.format?.duration ?? '0')
    const vs = (probe.streams ?? []).find((s: any) => s.width)
    job.width = vs?.width
    job.height = vs?.height
    const has264 = (probe.streams ?? []).some((s: any) => s.codec_name === 'h264')
    const hasAac = (probe.streams ?? []).some((s: any) => s.codec_name === 'aac')
    if (!has264 || !hasAac) {
      throw new Error(`codec check failed: h264=${has264} aac=${hasAac}`)
    }
    if (job.width !== 1080 || job.height !== 1920) {
      throw new Error(`resolution check failed: got ${job.width}x${job.height}, want 1080x1920`)
    }
    // duration sanity vs recipe (tolerance 1.5s) — reported, surfaced to UI/tests
    const expected = recipe.duration ?? (recipe.source ? recipe.source.clip_end! - recipe.source.clip_start! : 0)
    job.durationOk = !(expected > 0 && Math.abs((job.duration ?? 0) - expected) > 1.5)

    // ---- cover frame (optional): extract a JPG from the RENDERED output at
    // the requested OUTPUT time — the exact frame users previewed in the UI
    // (same keep-range math), NOT a re-decode of the source. A failed cover
    // extraction degrades honestly (no cover, MP4 still valid) — it must never
    // fail a finished render.
    if (recipe.cover) {
      const coverStart = Date.now()
      const t = Math.min(Math.max(0, recipe.cover.timestamp), Math.max(0, (job.duration ?? recipe.duration) - 0.05))
      const coverPath = join(jobDir, 'cover.jpg')
      const coverRes = await run(
        ['ffmpeg', '-nostdin', '-y', '-ss', timeToFFmpeg(t), '-i', outPath, '-frames:v', '1', '-q:v', '2', coverPath],
        jobDir, job, 'Extracting cover frame', 96, 98, 60_000,
      )
      if (coverRes.code === 0 && existsSync(coverPath) && statSync(coverPath).size > 1024) {
        job.hasCover = true
        stageTiming(job, 'cover-extract', coverStart)
        console.log(`[${jobId}] cover extracted @ output ${t.toFixed(2)}s (${statSync(coverPath).size} bytes)`)
      } else {
        job.hasCover = false
        console.warn(`[${jobId}] cover extraction failed (code ${coverRes.code}) — rendering without cover`) 
        try { rmSync(coverPath) } catch {}
      }
    }

    stageTiming(job, 'finalize', finalizeStart)
    // CANCELLATION INVARIANT: a job cancelled during finalization (probe / cover
    // extraction) must NEVER be finalized as done. transition() refuses the
    // cancelled → done edge — and when it refuses we return WITHOUT touching
    // stage/progress (no "Render complete", no progress=100, no broadcast).
    if (!transition(job, 'done')) return // cancelled mid-finalize → terminal state stands
    job.stage = 'Render complete'
    job.progress = 100
    job.finishedAt = Date.now()
    broadcast(job)
    console.log(`[${jobId}] done: ${outName} (${job.size} bytes, ${job.duration}s, ${job.width}x${job.height}) total=${((Date.now() - jobStart) / 1000).toFixed(1)}s`)
  } catch (e: any) {
    if (job.status === 'cancelled') return // cancellation already broadcast — do not overwrite
    job.status = 'error'
    job.error = e?.message ?? 'Unknown error'
    job.stage = 'Failed'
    job.finishedAt = Date.now()
    broadcast(job)
    console.error(`[${jobId}] error:`, job.error)
  } finally {
    // CLEANUP FOR EVERY TERMINAL OUTCOME (done / error / cancelled):
    // the old code only scheduled cleanup on the success path, so a cancelled
    // or failed job leaked its input (up to 1.5 GB) and its registry entry
    // forever. The output stays downloadable for the same 10-minute window as
    // before; after that the job dir and registry entry are gone.
    setTimeout(() => {
      try { rmSync(jobDir, { recursive: true, force: true }) } catch {}
      jobs.delete(jobId)
    }, 600000)
  }
}

function json(obj: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

serve({
  port: PORT,
  // SECURITY: explicit loopback bind. Do NOT rely on the implicit default
  // (0.0.0.0 = all interfaces). Only the local Next.js proxy may reach this.
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    // POST /render — start a render job
    if (req.method === 'POST' && url.pathname === '/render') {
      const contentType = req.headers.get('content-type') ?? ''
      if (!contentType.includes('multipart/form-data')) return json({ error: 'Expected multipart/form-data' }, 400)
      // resource guard: reject oversized uploads BEFORE parsing the body
      const lenHeader = req.headers.get('content-length')
      const declaredLen = lenHeader ? Number(lenHeader) : NaN
      if (isFinite(declaredLen) && declaredLen > RECIPE_LIMITS.MAX_UPLOAD_BYTES) {
        return json({ error: `Upload exceeds the ${Math.round(RECIPE_LIMITS.MAX_UPLOAD_BYTES / (1024 * 1024))} MB cap` }, 413)
      }
      const form = await req.formData()
      const file = form.get('video') as File | null
      const recipeRaw = form.get('recipe') as string | File | null
      if (!file) return json({ error: 'video file required' }, 400)
      if (!recipeRaw) return json({ error: 'recipe JSON required' }, 400)
      let parsedRecipe: unknown
      try {
        const rawText = typeof recipeRaw === 'string' ? recipeRaw : await recipeRaw.text()
        if (Buffer.byteLength(rawText, 'utf8') > RECIPE_LIMITS.MAX_RECIPE_BYTES) {
          return json({ error: `Recipe JSON exceeds the ${Math.round(RECIPE_LIMITS.MAX_RECIPE_BYTES / 1024)} KB limit`, code: 'RECIPE_TOO_LARGE' }, 413)
        }
        parsedRecipe = JSON.parse(rawText)
      } catch {
        return json({ error: 'invalid recipe JSON' }, 400)
      }
      // STRICT contract enforcement — the renderer never executes unvalidated JSON
      const v = validateRecipe(parsedRecipe)
      if (!v.ok) {
        return json({ error: v.error, code: v.code }, 400)
      }
      const id = randomUUID()
      const job: RenderJob = {
        id, status: 'queued', progress: 0, stage: 'Queued', createdAt: Date.now(), recipeDuration: 10, subscribers: new Set(),
      }
      jobs.set(id, job)
      // start async processing
      processJob(id, file, v.recipe)
      return json({ id, status: 'queued', progress: 0 })
    }

    // GET /jobs/:id — poll status
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/)
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1])
      if (!job) return json({ error: 'job not found' }, 404)
      return json(publicJob(job))
    }

    // GET /jobs/:id/stream — SSE progress
    const streamMatch = url.pathname.match(/^\/jobs\/([^/]+)\/stream$/)
    if (req.method === 'GET' && streamMatch) {
      const job = jobs.get(streamMatch[1])
      if (!job) return json({ error: 'job not found' }, 404)
      const stream = new ReadableStream({
        start(controller) {
          const send = (data: string) => {
            try { controller.enqueue(new TextEncoder().encode(data)) } catch {}
          }
          job.subscribers.add(send)
          // send initial
          send(`data: ${JSON.stringify(publicJob(job))}\n\n`)
          // keepalive
          const ka = setInterval(() => send(`: keepalive\n\n`), 15000)
          // cleanup on close
          ;(controller as any).originalClose = (controller as any).close
          const cleanup = () => {
            clearInterval(ka)
            job.subscribers.delete(send)
          }
          req.signal.addEventListener('abort', cleanup)
        },
        cancel() {},
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
    }

    // POST /jobs/:id/cancel — cancel a queued/running job (kills ffmpeg)
    const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/)
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1])
      if (!job) return json({ error: 'job not found' }, 404)
      if (!isActive(job.status)) {
        // terminal states are final — a cancelled/completed job cannot be re-cancelled
        return json({ id: job.id, status: job.status, progress: job.progress })
      }
      transition(job, 'cancelled')
      job.stage = 'Cancelled by user'
      job.finishedAt = Date.now()
      try { job.currentChild?.kill('SIGKILL') } catch {}
      broadcast(job)
      return json({ id: job.id, status: 'cancelled', progress: job.progress })
    }

    // GET /jobs/:id/download — download rendered MP4
    const dlMatch = url.pathname.match(/^\/jobs\/([^/]+)\/download$/)
    if (req.method === 'GET' && dlMatch) {
      const job = jobs.get(dlMatch[1])
      if (!job || job.status !== 'done') return json({ error: 'render not ready' }, 404)
      const jobDir = join(WORKDIR, job.id)
      const outPath = join(jobDir, job.filename!)
      if (!existsSync(outPath)) return json({ error: 'file expired' }, 410)
      // MEMORY SAFETY: stream the file from disk (Bun.file is a streaming blob
      // source) — a 500 MB MP4 must never be materialized in the JS heap.
      const size = statSync(outPath).size
      const res = new Response(Bun.file(outPath), {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="${job.filename}"`,
          'Content-Length': String(size),
        },
      })
      return res
    }

    // GET /jobs/:id/cover — download the extracted cover-frame JPG (when requested)
    const coverMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cover$/)
    if (req.method === 'GET' && coverMatch) {
      const job = jobs.get(coverMatch[1])
      if (!job || job.status !== 'done') return json({ error: 'render not ready' }, 404)
      if (!job.hasCover) return json({ error: 'no cover was requested for this render' }, 404)
      const coverPath = join(WORKDIR, job.id, 'cover.jpg')
      if (!existsSync(coverPath)) return json({ error: 'file expired' }, 410)
      const coverSize = statSync(coverPath).size
      const base = sanitize(job.filename?.replace(/\.mp4$/i, '') ?? 'clip')
      const res = new Response(Bun.file(coverPath), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Disposition': `attachment; filename="cover_${base}.jpg"`,
          'Content-Length': String(coverSize),
          'Cache-Control': 'private, max-age=300',
        },
      })
      return res
    }

    // GET / — health
    return json({ service: 'ClipForge ffmpeg renderer', port: PORT, endpoints: {
      'POST /render': 'multipart (video, recipe) → {id}',
      'GET /jobs/:id': 'poll status',
      'GET /jobs/:id/stream': 'SSE progress',
      'GET /jobs/:id/download': 'download MP4',
      'GET /jobs/:id/cover': 'download cover-frame JPG (when recipe.cover was set)',
    } })
  },
})
console.log(`ClipForge ffmpeg-renderer running on http://127.0.0.1:${PORT}`)

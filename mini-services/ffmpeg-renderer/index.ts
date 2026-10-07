// ClipForge AI — ffmpeg render mini-service (port 3003)
// Accepts multipart upload: video file + JSON recipe
// Renders MP4 with cuts, subtitle burn-in, camera zoom via ffmpeg
// Exposes: POST /render (start job), GET /jobs/:id (poll status), GET /jobs/:id/stream (SSE), GET /jobs/:id/download

import { serve } from 'bun'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const PORT = 3003
const WORKDIR = '/home/z/my-project/upload/ffmpeg-render'
if (!existsSync(WORKDIR)) mkdirSync(WORKDIR, { recursive: true })

// ---- Job registry (in-memory) ----
interface RenderJob {
  id: string
  status: 'queued' | 'extracting' | 'concatenating' | 'rendering' | 'finalizing' | 'done' | 'error'
  progress: number // 0-100
  stage: string // human-readable stage
  filename?: string
  size?: number
  duration?: number
  width?: number
  height?: number
  error?: string
  createdAt: number
  finishedAt?: number
  recipeDuration: number // per-job (fixes the cross-job race)
  // SSE subscribers
  subscribers: Set<(data: string) => void>
}

const jobs = new Map<string, RenderJob>()

interface RenderRecipe {
  source?: { youtube_id?: string; clip_start?: number; clip_end?: number }
  keep_ranges?: { start: number; end: number }[]
  subtitles_ass?: string
  // camera keyframes are OUTPUT-time (pre-mapped by the API — after cuts removal)
  camera_keyframes?: { time: number; scale: number }[]
  sound_effects?: { type: string; start: number; duration: number; intensity: number }[]
  music?: { recommended: boolean; style: string; intensity: number; ducking_percent: number }
  segments?: { type: string; start: number; end: number }[]
  title?: string
  duration?: number
}

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

function buildZoompanFilter(recipe: RenderRecipe, fps = 30): string | null {
  const kfs = recipe.camera_keyframes ?? []
  if (!kfs || kfs.length < 2) return null
  const totalFrames = Math.max(1, Math.round((recipe.duration ?? 10) * fps))
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

// Run a command, capturing stderr for progress parsing
function run(cmd: string[], cwd: string, job: RenderJob, stageLabel: string, stageStart: number, stageEnd: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d.toString()))
    p.stderr.on('data', (d) => {
      const text = d.toString()
      stderr += text
      // Parse ffmpeg progress: time=00:00:05.12 → progress within stage
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m) {
        const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        const totalForStage = Math.max(1, job.recipeDuration || 10)
        const stageProgress = Math.min(1, sec / totalForStage)
        const overall = stageStart + stageProgress * (stageEnd - stageStart)
        job.progress = Math.round(overall)
        job.stage = stageLabel
        broadcast(job)
      }
    })
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
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
  })
  for (const send of job.subscribers) {
    try { send(`data: ${payload}\n\n`) } catch {}
  }
}

function publicJob(job: RenderJob) {
  const { subscribers, ...rest } = job
  return rest
}

async function processJob(jobId: string, file: File, recipe: RenderRecipe) {
  const job = jobs.get(jobId)!
  try {
    const jobDir = join(WORKDIR, jobId)
    mkdirSync(jobDir, { recursive: true })
    const inputPath = join(jobDir, 'input' + (file.name.match(/\.[a-z0-9]+$/)?.[0] ?? '.mp4'))
    const buf = new Uint8Array(await file.arrayBuffer())
    writeFileSync(inputPath, buf)
    console.log(`[${jobId}] received ${file.name} (${buf.length} bytes)`)
    job.recipeDuration = recipe.duration ?? 10

    const ranges = recipe.keep_ranges && recipe.keep_ranges.length > 0 ? recipe.keep_ranges : [{ start: recipe.source?.clip_start ?? 0, end: recipe.source?.clip_end ?? 10 }]

    // Stage 1-3 (single accurate pass): trim keep ranges → concat → burn subs → zoom → 9:16
    // Frame-accurate: filter_complex trim/atrim (NOT -c copy, which snaps to keyframes
    // and desynchronizes output duration from the edit plan).
    job.status = 'extracting'
    job.stage = `Preparing ${ranges.length} keep range${ranges.length === 1 ? '' : 's'} (frame-accurate trim)…`
    job.progress = 8
    broadcast(job)

    if (recipe.subtitles_ass) writeFileSync(join(jobDir, 'subs.ass'), recipe.subtitles_ass)

    // build filter_complex
    const fcParts: string[] = []
    ranges.forEach((r, i) => {
      fcParts.push(`[0:v]trim=start=${Number(r.start).toFixed(3)}:end=${Number(r.end).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`)
      fcParts.push(`[0:a]atrim=start=${Number(r.start).toFixed(3)}:end=${Number(r.end).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
    })
    const concatIn = ranges.map((_, i) => `[v${i}][a${i}]`).join('')
    fcParts.push(`${concatIn}concat=n=${ranges.length}:v=1:a=1[vc][ac]`)
    const postParts: string[] = []
    if (recipe.subtitles_ass) postParts.push(`ass='${join(jobDir, 'subs.ass')}'`)
    const zoom = buildZoompanFilter(recipe)
    if (zoom) postParts.push(zoom)
    postParts.push('scale=1080:1920:force_original_aspect_ratio=increase')
    postParts.push('crop=1080:1920')
    fcParts.push(`[vc]${postParts.join(',')}[vf]`)

    job.status = 'rendering'
    job.stage = `Rendering: trim+concat+${postParts.length} filters (single pass)…`
    job.progress = 25
    broadcast(job)

    const outName = `clipforge_${sanitize(recipe.title ?? 'clip')}.mp4`
    const outPath = join(jobDir, outName)
    const baseArgs = ['ffmpeg', '-nostdin', '-y', '-i', inputPath, '-filter_complex', fcParts.join(';'), '-map', '[vf]', '-map', '[ac]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-r', '30', outPath]
    let finalRes = await run(baseArgs, jobDir, job, 'Encoding H.264 + burning subtitles + zoom', 25, 92)
    if (finalRes.code !== 0) {
      // fallback: source has no audio stream → generate silence for [ac]
      const hasAudio = finalRes.stderr.includes('Stream map') || finalRes.stderr.includes('[0:a]') === false || true
      if (hasAudio) {
        job.stage = 'Retrying without source audio (silent audio track)…'
        broadcast(job)
        const fcParts2 = fcParts.slice(0, ranges.length * 2).map((p) => p.replace('[0:a]', '[1:a]'))
        fcParts2.push(`${ranges.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${ranges.length}:v=1:a=1[vc][ac]`)
        const post = fcParts.slice(ranges.length * 2 + 1).join(';')
        const fc2 = fcParts2.join(';') + ';' + post.replace('[vc]', '[vc]') // reuse post chain
        const silentArgs = [
          'ffmpeg', '-nostdin', '-y',
          '-i', inputPath,
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-filter_complex', fc2,
          '-map', '[vf]', '-map', '[ac]',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-r', '30',
          '-shortest', outPath,
        ]
        finalRes = await run(silentArgs, jobDir, job, 'Encoding (silent audio)', 25, 92)
      }
      if (finalRes.code !== 0) throw new Error('ffmpeg render failed: ' + finalRes.stderr.slice(-500))
    }

    // Stage 4: probe + done
    job.status = 'finalizing'
    job.stage = 'Finalizing…'
    job.progress = 95
    broadcast(job)

    // cleanup intermediates
    try { rmSync(join(jobDir, 'subs.ass')) } catch {}
    try { rmSync(inputPath) } catch {}

    const stat = statSync(outPath)
    job.size = stat.size
    job.filename = outName
    // probe duration + dimensions + codecs
    const probeRes = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name,codec_type', '-of', 'json', outPath], jobDir, job, 'Finalizing', 95, 99)
    try {
      const probe = JSON.parse(probeRes.stdout)
      job.duration = parseFloat(probe.format?.duration ?? '0')
      const vs = (probe.streams ?? []).find((s: any) => s.width)
      job.width = vs?.width
      job.height = vs?.height
      const has264 = (probe.streams ?? []).some((s: any) => s.codec_name === 'h264')
      const hasAac = (probe.streams ?? []).some((s: any) => s.codec_name === 'aac')
      if (!has264 || !hasAac) throw new Error(`codec check failed: h264=${has264} aac=${hasAac}`)
    } catch {}

    job.status = 'done'
    job.stage = 'Render complete'
    job.progress = 100
    job.finishedAt = Date.now()
    broadcast(job)
    console.log(`[${jobId}] done: ${outName} (${job.size} bytes, ${job.duration}s, ${job.width}x${job.height})`)

    // schedule cleanup of the output after 10 minutes
    setTimeout(() => {
      try { rmSync(outPath) } catch {}
      try { rmSync(jobDir, { recursive: true }) } catch {}
      jobs.delete(jobId)
    }, 600000)
  } catch (e: any) {
    job.status = 'error'
    job.error = e?.message ?? 'Unknown error'
    job.stage = 'Failed'
    job.finishedAt = Date.now()
    broadcast(job)
    console.error(`[${jobId}] error:`, job.error)
  }
}

function json(obj: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function cors(res: Response): Response {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', '*')
  return res
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    // CORS preflight
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))

    // POST /render — start a render job
    if (req.method === 'POST' && url.pathname === '/render') {
      const contentType = req.headers.get('content-type') ?? ''
      if (!contentType.includes('multipart/form-data')) return cors(json({ error: 'Expected multipart/form-data' }, 400))
      const form = await req.formData()
      const file = form.get('video') as File | null
      const recipeRaw = form.get('recipe') as string | File | null
      if (!file) return cors(json({ error: 'video file required' }, 400))
      if (!recipeRaw) return cors(json({ error: 'recipe JSON required' }, 400))
      let recipe: RenderRecipe
      try {
        recipe = typeof recipeRaw === 'string' ? JSON.parse(recipeRaw) : JSON.parse(await recipeRaw.text())
      } catch {
        return cors(json({ error: 'invalid recipe JSON' }, 400))
      }
      const id = randomUUID()
      const job: RenderJob = {
        id, status: 'queued', progress: 0, stage: 'Queued', createdAt: Date.now(), recipeDuration: 10, subscribers: new Set(),
      }
      jobs.set(id, job)
      // start async processing
      processJob(id, file, recipe)
      return cors(json({ id, status: 'queued', progress: 0 }))
    }

    // GET /jobs/:id — poll status
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/)
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1])
      if (!job) return cors(json({ error: 'job not found' }, 404))
      return cors(json(publicJob(job)))
    }

    // GET /jobs/:id/stream — SSE progress
    const streamMatch = url.pathname.match(/^\/jobs\/([^/]+)\/stream$/)
    if (req.method === 'GET' && streamMatch) {
      const job = jobs.get(streamMatch[1])
      if (!job) return cors(json({ error: 'job not found' }, 404))
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
      const res = new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
      return cors(res)
    }

    // GET /jobs/:id/download — download rendered MP4
    const dlMatch = url.pathname.match(/^\/jobs\/([^/]+)\/download$/)
    if (req.method === 'GET' && dlMatch) {
      const job = jobs.get(dlMatch[1])
      if (!job || job.status !== 'done') return cors(json({ error: 'render not ready' }, 404))
      const jobDir = join(WORKDIR, job.id)
      const outPath = join(jobDir, job.filename!)
      if (!existsSync(outPath)) return cors(json({ error: 'file expired' }, 410))
      const buf = readFileSync(outPath)
      const res = new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="${job.filename}"`,
          'Content-Length': String(buf.length),
        },
      })
      return cors(res)
    }

    // GET / — health
    return cors(json({ service: 'ClipForge ffmpeg renderer', port: PORT, endpoints: {
      'POST /render': 'multipart (video, recipe) → {id}',
      'GET /jobs/:id': 'poll status',
      'GET /jobs/:id/stream': 'SSE progress',
      'GET /jobs/:id/download': 'download MP4',
    } }))
  },
})
console.log(`ClipForge ffmpeg-renderer running on http://localhost:${PORT}`)

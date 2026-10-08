import { NextRequest, NextResponse } from 'next/server'
import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { checkRateLimit } from '@/lib/validation'
import { getOrCreateSessionId } from '@/lib/session'
import { recordUsage } from '@/lib/usage'
import { mediaMimeForExt, resolveLocalMediaPath } from '@/lib/media'
import { touchMediaCache } from '@/lib/media-cache'
import { checkDailyUsageLimit, limitHeaders, limitReachedMessage } from '@/lib/usage-limits'

// Proxy from /api/render-proxy/[...path] to the ffmpeg-renderer mini-service at 127.0.0.1:3003
// Keeps the mini-service internal (never publicly exposed).
//
// ─── SECURITY: JOB OWNERSHIP (10/10 mission, Phase 1.1) ─────────────────────
// Every job operation (poll, SSE stream, cancel, download, cover frame) is
// AUTHORIZED here against the RenderJob table BEFORE touching the renderer:
//   POST /render  → records (jobId, ownerId, projectId) on success
//   POST /jobs/:id/cancel   → 404 unless the row exists AND ownerId matches
//   GET  /jobs/:id          → 404 unless owned
//   GET  /jobs/:id/stream   → 404 unless owned
//   GET  /jobs/:id/download → 404 unless owned
//   GET  /jobs/:id/cover    → 404 unless owned
// Random UUID secrecy is NEVER relied on; ownership lives in the DB.
// The renderer is a trusted internal service (localhost only); this proxy is
// the public-facing authorization boundary.
//
// Two input modes for renders (POST /render):
//   1. multipart passthrough — the client uploads the source video (Upload tab)
//   2. JSON { recipe, projectId } — the renderer input is the server-side media
//      persisted on the owned project (downloaded YouTube source / upload kept
//      by the transcribe job). The proxy resolves the path FROM THE DB (the
//      client NEVER sends a path), validates ownership + path containment, and
//      STREAMS the file into a manually-built multipart body (no 1.5 GB RAM
//      buffer) — the renderer contract is unchanged.
//
// ─── MEMORY SAFETY (both directions) ─────────────────────────────────────────
//   Upload:  browser → ReadableStream (byte-capped) → this proxy → renderer
//            The multipart body is NEVER materialized via req.blob()/
//            req.arrayBuffer(); an 8 MB-capped byte counter enforces the size
//            limit DURING streaming (also covers chunked uploads that omit
//            Content-Length, where a declared-length precheck is impossible).
//   Download: renderer → stream → this proxy → browser. MP4/cover responses
//            are piped through, never buffered (no 500 MB arrayBuffer()).

const RENDERER_BASE = 'http://127.0.0.1:3003'

// resource limits (mission Phase 1.3) — mirror the renderer's own guards
const MAX_SOURCE_BYTES = 1500 * 1024 * 1024 // 1.5 GB
const MAX_RECIPE_BYTES = 1024 * 1024 // 1 MiB (matches renderer validation)
const STREAM_CHUNK = 8 * 1024 * 1024 // 8 MB streaming chunks

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const JOB_PATH_RE = /^\/jobs\/([\w-]+)(\/(stream|download|cover|cancel))?$/

/**
 * Wrap an incoming request stream with a hard byte cap so chunked uploads
 * (no Content-Length) cannot exceed the source limit mid-flight. Errors the
 * stream when the cap is exceeded — the upstream fetch aborts, the renderer's
 * formData() parse fails, and the caller sees 413 (never an OOM).
 * onCap fires synchronously at the moment the cap trips (for honest errors).
 */
function byteCappedStream(src: ReadableStream<Uint8Array>, maxBytes: number, onCap?: () => void): ReadableStream<Uint8Array> {
  let total = 0
  return src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        total += chunk.byteLength
        if (total > maxBytes) {
          onCap?.()
          ctrl.error(new Error('PAYLOAD_TOO_LARGE'))
          return
        }
        ctrl.enqueue(chunk)
      },
    }),
  )
}

/** Map a renderer status string to the canonical DB status (upper-snake). */
function canonicalStatus(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const map: Record<string, string> = {
    queued: 'QUEUED',
    extracting: 'EXTRACTING',
    rendering: 'RENDERING',
    finalizing: 'FINALIZING',
    done: 'DONE',
    error: 'ERROR',
    cancelled: 'CANCELLED',
  }
  return map[s] ?? null
}

/** Authorize a job operation: the row must exist AND belong to this session. */
async function authorizeJob(jobId: string): Promise<boolean> {
  if (!jobId || !/^[\w-]{8,64}$/.test(jobId)) return false
  const ownerId = await getOrCreateSessionId()
  const row = await db.renderJob.findUnique({ where: { id: jobId }, select: { ownerId: true } })
  return !!row && row.ownerId === ownerId
}

/** Opportunistically sync terminal/progress status into the DB row (cheap, only on change). */
async function syncJobStatus(jobId: string, upstreamStatus: unknown, upstreamStage: unknown) {
  try {
    const status = canonicalStatus(upstreamStatus)
    if (!status) return
    const row = await db.renderJob.findUnique({ where: { id: jobId }, select: { status: true, stage: true } })
    if (!row) return
    const stage = typeof upstreamStage === 'string' ? upstreamStage : null
    if (row.status !== status || (stage && row.stage !== stage)) {
      await db.renderJob.update({ where: { id: jobId }, data: { status, ...(stage ? { stage: stage.slice(0, 300) } : {}) } })
    }
  } catch {
    // sync is best-effort observability — never break the poll
  }
}

/** Persist render-job ownership after a successful render start (security invariant).
 * Returns { ok, rendererJobId }: ok=false means the DB row is NOT guaranteed —
 * the caller MUST cancel the renderer job and fail honestly. A silently-swallowed
 * failure here used to strand a renderer job the client could never poll,
 * cancel, or download (every proxy operation 404s fail-closed). */
async function recordRenderJob(
  upstreamBody: string,
  projectId: string | null,
  fallbackStatus = 'QUEUED',
): Promise<{ ok: boolean; rendererJobId: string | null }> {
  let rendererJobId: string | null = null
  try {
    const parsed = JSON.parse(upstreamBody) as { id?: unknown; status?: unknown }
    if (typeof parsed?.id !== 'string' || !/^[\w-]{8,64}$/.test(parsed.id)) {
      return { ok: false, rendererJobId: null } // upstream contract broken — nothing to cancel by id
    }
    rendererJobId = parsed.id
    const ownerId = await getOrCreateSessionId()
    await db.renderJob.upsert({
      where: { id: parsed.id },
      create: {
        id: parsed.id,
        ownerId,
        projectId,
        status: canonicalStatus(parsed.status) ?? fallbackStatus,
        stage: 'Queued',
      },
      update: { ownerId, projectId },
    })
    return { ok: true, rendererJobId }
  } catch {
    // DB/session failure — report to the caller so the renderer job is cancelled
    // and the client gets an honest 5xx (never a doomed job id).
    return { ok: false, rendererJobId }
  }
}

/**
 * Build a multipart/form-data body as a CONSUMER-DRIVEN stream (pull-based):
 * file reads happen only when the downstream fetch pulls — memory stays bounded
 * at ~2 chunks regardless of source size (the old start()-pump enqueued the
 * ENTIRE file into the stream's internal queue as fast as disk allowed, which
 * re-materialized a 1.5 GB source chunk-by-chunk in RAM).
 * Returns the stream AND the boundary (needed for the Content-Type header).
 */
function buildStreamingMultipart(
  absolutePath: string,
  fileMime: string,
  fileName: string,
  recipeJson: string,
): { stream: ReadableStream<Uint8Array>; boundary: string } {
  const boundary = `----clipforge${randomUUID().replace(/-/g, '')}`
  const pre = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${fileName.replace(/["\r\n]/g, '_')}"\r\nContent-Type: ${fileMime}\r\n\r\n`,
  )
  const post = new TextEncoder().encode(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="recipe"\r\n\r\n${recipeJson}\r\n--${boundary}--\r\n`,
  )
  const CHUNK = STREAM_CHUNK
  let stage: 'pre' | 'file' | 'post' | 'done' = 'pre'
  let fh: import('node:fs/promises').FileHandle | null = null
  const buf = Buffer.allocUnsafe(CHUNK)
  let position = 0
  const release = async () => {
    const h = fh
    fh = null
    if (h) {
      try { await h.close() } catch { /* already closed */ }
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (stage === 'pre') {
          controller.enqueue(pre)
          stage = 'file'
          return
        }
        if (stage === 'file') {
          if (!fh) fh = await open(absolutePath, 'r')
          const { bytesRead } = await fh.read(buf, 0, CHUNK, position)
          if (bytesRead <= 0) {
            stage = 'post'
            return // pull is called again immediately → 'post' branch below
          }
          controller.enqueue(new Uint8Array(buf.subarray(0, bytesRead))) // copy — buf is reused
          position += bytesRead
          return
        }
        if (stage === 'post') {
          controller.enqueue(post)
          stage = 'done'
          controller.close()
          await release()
          return
        }
        // stage === 'done' — stream closed; nothing further to produce
      } catch (e) {
        await release()
        controller.error(e)
      }
    },
    async cancel() {
      // downstream aborted mid-upload (renderer 4xx, cap trip, client cancel):
      // release the file handle — the read loop never runs again.
      await release()
    },
  })
  return { stream, boundary }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
  const targetPath = '/' + path.join('/')

  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const contentType = req.headers.get('content-type') ?? ''

  // render starts are expensive → rate limit; job cancels are cheap but still authorized
  const isRenderStart = targetPath === '/render'
  if (isRenderStart) {
    const rl = checkRateLimit(`render:${ip}`, 6, 60_000)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded — too many renders. Please wait a minute.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      )
    }
  }

  // ---- ownership gate for job operations (cancel) ----
  const jobMatch = targetPath.match(JOB_PATH_RE)
  if (jobMatch) {
    const ok = await authorizeJob(jobMatch[1])
    if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const targetUrl = RENDERER_BASE + targetPath + (url.search || '')

  let body: BodyInit
  const headers: Record<string, string> = {}
  let rawBody: string | null = null
  let recipeJson: string | null = null
  let projectIdForRecord: string | null = null
  let payloadTooLarge = false // set when the byte cap trips mid-stream

  if (contentType.includes('application/json') && targetPath === '/render') {
    // ---- JSON mode: project-source render (server-side media) ----
    rawBody = await req.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_RECIPE_BYTES + 4096) {
      return NextResponse.json({ error: 'Request body too large', code: 'RECIPE_TOO_LARGE' }, { status: 413 })
    }
    let parsed: { recipe?: unknown; projectId?: unknown } = {}
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    projectIdForRecord = typeof parsed.projectId === 'string' ? parsed.projectId : null
    recipeJson = typeof parsed.recipe === 'string' ? parsed.recipe : null
    if (!projectIdForRecord || !recipeJson) {
      return NextResponse.json({ error: 'projectId and recipe are required' }, { status: 400 })
    }
    if (Buffer.byteLength(recipeJson, 'utf8') > MAX_RECIPE_BYTES) {
      return NextResponse.json({ error: 'Recipe JSON exceeds the 1 MB limit', code: 'RECIPE_TOO_LARGE' }, { status: 413 })
    }
    const ownerId = await getOrCreateSessionId()

    // ---------- daily soft limit (persisted usage, friendly 429) ----------
    const daily = await checkDailyUsageLimit(ownerId, 'render')
    if (!daily.allowed) {
      return NextResponse.json(
        { error: limitReachedMessage({ ...daily, kind: 'render' }), code: 'DAILY_LIMIT_REACHED', kind: 'render', used: daily.used, cap: daily.cap, resetAt: daily.resetAt },
        { status: 429, headers: limitHeaders(daily) },
      )
    }

    const project = await db.project.findFirst({
      where: { id: projectIdForRecord, ownerId },
      select: { localMedia: true, localMediaState: true, localMediaSize: true, title: true, youtubeId: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    // rendering from the cached source is an LRU touch (throttled, best-effort)
    if (project.youtubeId && project.localMedia?.startsWith('upload/yt/')) {
      touchMediaCache(project.youtubeId)
    }
    if (project.localMediaState !== 'ready' || !project.localMedia) {
      return NextResponse.json(
        { error: 'This project has no downloadable source media (state: ' + (project.localMediaState ?? 'unavailable') + '). Upload the video file instead.' },
        { status: 409 },
      )
    }
    const absolute = resolveLocalMediaPath(project.localMedia)
    if (!absolute) {
      return NextResponse.json({ error: 'Stored media path failed validation' }, { status: 500 })
    }
    let sizeBytes = 0
    try {
      sizeBytes = statSync(absolute).size
    } catch {
      return NextResponse.json(
        { error: 'Stored source media is missing on disk — re-run source prepare or upload the file.' },
        { status: 410 },
      )
    }
    if (sizeBytes > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Stored source media exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    // STREAM the stored media into a multipart body — no whole-file RAM buffer.
    const mime = mediaMimeForExt(absolute.split('.').pop() ?? '') ?? 'video/mp4'
    const mp = buildStreamingMultipart(absolute, mime, basename(absolute), recipeJson)
    body = mp.stream
    headers['content-type'] = `multipart/form-data; boundary=${mp.boundary}`

    // ---- usage metering: a render START is the billable action (best-effort) ----
    try {
      let renderSeconds: number | undefined
      try {
        const r = JSON.parse(recipeJson) as { output_duration?: number }
        renderSeconds = isFinite(Number(r?.output_duration)) ? Number(r.output_duration) : undefined
      } catch { /* quantity=1 still recorded */ }
      void recordUsage(ownerId, 'render', 1, { renderSeconds, projectId: projectIdForRecord })
    } catch { /* never block rendering */ }
  } else if (contentType.includes('multipart/form-data')) {
    // resource guard: reject declared oversize uploads BEFORE streaming starts
    const declaredLen = Number(req.headers.get('content-length') ?? '')
    if (isFinite(declaredLen) && declaredLen > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Upload exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    // MEMORY SAFETY: forward the multipart body AS A STREAM (byte-capped).
    // The old `await req.blob()` materialized the entire upload (up to 1.5 GB)
    // in server RAM before a single byte reached the renderer.
    if (!req.body) {
      return NextResponse.json({ error: 'Empty multipart body' }, { status: 400 })
    }
    body = byteCappedStream(req.body, MAX_SOURCE_BYTES, () => { payloadTooLarge = true })
    headers['content-type'] = contentType // preserves the multipart boundary
  } else {
    rawBody = await req.text()
    body = rawBody
    headers['content-type'] = contentType || 'application/json'
  }

  // usage metering + daily soft limit for the multipart passthrough path (recipe not parsed here)
  if (isRenderStart && !recipeJson) {
    try {
      const ownerId = await getOrCreateSessionId()
      const daily = await checkDailyUsageLimit(ownerId, 'render')
      if (!daily.allowed) {
        return NextResponse.json(
          { error: limitReachedMessage({ ...daily, kind: 'render' }), code: 'DAILY_LIMIT_REACHED', kind: 'render', used: daily.used, cap: daily.cap, resetAt: daily.resetAt },
          { status: 429, headers: limitHeaders(daily) },
        )
      }
      void recordUsage(ownerId, 'render', 1, {})
    } catch { /* never block rendering */ }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body,
      // propagate client disconnects as a CONTROLLED abort — without this,
      // a mid-upload disconnect surfaces later as an undici socket error
      // (unhandledRejection: TypeError: terminated)
      signal: req.signal,
      // @ts-expect-error — undici duplex option for stream bodies
      duplex: 'half',
    })
    const respBody = await upstream.arrayBuffer()
    // record ownership for the NEW job (both render modes) — required for all
    // subsequent poll/stream/cancel/download authorization. A recording failure
    // must NOT be silent: cancel the renderer job (no orphan work) and fail
    // honestly — the client must never receive an id that every later operation
    // would 404.
    if (upstream.ok) {
      const recorded = await recordRenderJob(Buffer.from(respBody).toString('utf8'), projectIdForRecord)
      if (!recorded.ok) {
        if (recorded.rendererJobId) {
          try {
            await fetch(`${RENDERER_BASE}/jobs/${recorded.rendererJobId}/cancel`, { method: 'POST' })
          } catch { /* renderer unavailable — job self-expires with its artifacts */ }
        }
        return NextResponse.json(
          { error: 'Render started but job ownership could not be recorded; the render was cancelled. Please retry.' },
          { status: 500 },
        )
      }
    }
    return new NextResponse(respBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (e: any) {
    // the byte cap aborts the stream mid-flight → surface an honest 413
    if (payloadTooLarge || e?.message === 'PAYLOAD_TOO_LARGE') {
      return NextResponse.json({ error: 'Upload exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    return NextResponse.json({ error: e?.message ?? 'proxy failed' }, { status: 502 })
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
  const targetPath = '/' + path.join('/')

  // ---- ownership gate: poll / stream / download are ALL owner-scoped ----
  const jobMatch = targetPath.match(JOB_PATH_RE)
  if (jobMatch) {
    const ok = await authorizeJob(jobMatch[1])
    if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const targetUrl = RENDERER_BASE + targetPath + (url.search || '')

  // MEMORY SAFETY: download/cover are LARGE binary artifacts (full MP4s) —
  // pipe the upstream body straight through, never await arrayBuffer().
  // Poll (GET /jobs/:id) stays buffered: it is a tiny JSON document the proxy
  // also inspects for DB status sync.
  const binaryArtifact = jobMatch?.[3] === 'download' || jobMatch?.[3] === 'cover'

  try {
    // signal: client disconnect (closed EventSource / aborted download) must
    // abort the upstream fetch deterministically — otherwise the runtime's
    // cancellation of the passthrough body races undici's socket handling and
    // surfaces as an unhandled socket-error rejection.
    const upstream = await fetch(targetUrl, { method: 'GET', signal: req.signal })
    const ct = upstream.headers.get('content-type') ?? 'application/octet-stream'
    if (ct.includes('text/event-stream')) {
      // SSE: forward the upstream body DIRECTLY (byte-identical event format).
      // The old manual reader/pump wrapper never cancelled the upstream when the
      // browser disconnected (leaking the renderer connection + its subscriber),
      // and a read error inside the detached pump was an unhandled rejection that
      // left the downstream hanging. Native body passthrough propagates
      // backpressure, upstream errors, and downstream cancellation for free.
      if (!upstream.body) return new NextResponse(null, { status: 502 })
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        },
      })
    }
    if (binaryArtifact) {
      // STREAM THROUGH with the renderer's own headers preserved (content-type,
      // content-length, content-disposition, cache-control). The 404/410 error
      // bodies from the renderer are JSON — those stay buffered via the same
      // branch (status !== ok and tiny), but the header passthrough is harmless.
      const passthrough: Record<string, string> = { 'content-type': ct }
      for (const h of ['content-length', 'content-disposition', 'cache-control']) {
        const v = upstream.headers.get(h)
        if (v) passthrough[h] = v
      }
      if (!upstream.ok || !upstream.body) {
        // renderer error (404 not ready / 410 expired): relay the small JSON body
        const errBody = await upstream.text()
        return new NextResponse(errBody, { status: upstream.status, headers: { 'content-type': ct } })
      }
      return new NextResponse(upstream.body, { status: upstream.status, headers: passthrough })
    }
    const respBody = await upstream.arrayBuffer()
    // opportunistic DB status sync (observability) on plain job polls
    if (jobMatch && !jobMatch[3] && upstream.ok) {
      try {
        const j = JSON.parse(Buffer.from(respBody).toString('utf8')) as { status?: unknown; stage?: unknown }
        void syncJobStatus(jobMatch[1], j.status, j.stage)
      } catch { /* best-effort */ }
    }
    return new NextResponse(respBody, {
      status: upstream.status,
      headers: { 'content-type': ct },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'proxy failed' }, { status: 502 })
  }
}

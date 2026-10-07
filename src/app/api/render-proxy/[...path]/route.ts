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

// Proxy from /api/render-proxy/[...path] to the ffmpeg-renderer mini-service at localhost:3003
// Avoids CORS issues and keeps the mini-service internal (never publicly exposed).
//
// ─── SECURITY: JOB OWNERSHIP (10/10 mission, Phase 1.1) ─────────────────────
// Every job operation (poll, SSE stream, cancel, download) is AUTHORIZED here
// against the RenderJob table BEFORE touching the renderer:
//   POST /render  → records (jobId, ownerId, projectId) on success
//   POST /jobs/:id/cancel   → 404 unless the row exists AND ownerId matches
//   GET  /jobs/:id          → 404 unless owned
//   GET  /jobs/:id/stream   → 404 unless owned
//   GET  /jobs/:id/download → 404 unless owned
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

const RENDERER_BASE = 'http://localhost:3003'

// resource limits (mission Phase 1.3) — mirror the renderer's own guards
const MAX_SOURCE_BYTES = 1500 * 1024 * 1024 // 1.5 GB
const MAX_RECIPE_BYTES = 1024 * 1024 // 1 MiB (matches renderer validation)
const STREAM_CHUNK = 8 * 1024 * 1024 // 8 MB streaming chunks

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const JOB_PATH_RE = /^\/jobs\/([\w-]+)(\/(stream|download|cancel))?$/

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

/** Persist render-job ownership after a successful render start (security invariant). */
async function recordRenderJob(upstreamBody: string, projectId: string | null, fallbackStatus = 'QUEUED') {
  try {
    const parsed = JSON.parse(upstreamBody) as { id?: unknown; status?: unknown }
    if (typeof parsed?.id !== 'string' || !/^[\w-]{8,64}$/.test(parsed.id)) return
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
  } catch {
    // recording must never fail the render — but a failure here means the job
    // is NOT pollable/cancellable/downloadable through the proxy (fail closed)
  }
}

/**
 * Build a multipart/form-data body as a STREAM (video file read in chunks —
 * never fully buffered in memory) so a 1.5 GB source doesn't exhaust RAM.
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
  return {
    stream: new ReadableStream<Uint8Array>({
    async start(controller) {
      const fh = await open(absolutePath, 'r')
      try {
        controller.enqueue(pre)
        const buf = Buffer.allocUnsafe(STREAM_CHUNK)
        let position = 0
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, STREAM_CHUNK, position)
          if (bytesRead <= 0) break
          controller.enqueue(new Uint8Array(buf.subarray(0, bytesRead))) // copy — buf is reused
          position += bytesRead
        }
        controller.enqueue(post)
        controller.close()
      } finally {
        await fh.close()
      }
    },
    }),
    boundary,
  }
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
    // resource guard: reject oversized uploads BEFORE buffering the body
    const declaredLen = Number(req.headers.get('content-length') ?? '')
    if (isFinite(declaredLen) && declaredLen > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Upload exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    // forward multipart as-is
    body = await req.blob()
    headers['content-type'] = contentType
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
      // @ts-expect-error — undici duplex option for stream bodies
      duplex: 'half',
    })
    const respBody = await upstream.arrayBuffer()
    // record ownership for the NEW job (both render modes) — required for all
    // subsequent poll/stream/cancel/download authorization
    if (upstream.ok) {
      await recordRenderJob(Buffer.from(respBody).toString('utf8'), projectIdForRecord)
    }
    return new NextResponse(respBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (e: any) {
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

  try {
    const upstream = await fetch(targetUrl, { method: 'GET' })
    const ct = upstream.headers.get('content-type') ?? 'application/octet-stream'
    if (ct.includes('text/event-stream')) {
      // SSE: stream through
      const reader = upstream.body?.getReader()
      if (!reader) return new NextResponse(null, { status: 502 })
      const stream = new ReadableStream({
        start(controller) {
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                controller.close()
                return
              }
              controller.enqueue(value)
            }
          }
          pump()
        },
      })
      return new NextResponse(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        },
      })
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

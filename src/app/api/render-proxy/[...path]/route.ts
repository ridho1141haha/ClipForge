import { NextRequest, NextResponse } from 'next/server'
import { statSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { basename } from 'node:path'
import { db } from '@/lib/db'
import { checkRateLimit } from '@/lib/validation'
import { getOrCreateSessionId } from '@/lib/session'
import { recordUsage } from '@/lib/usage'
import { mediaMimeForExt, resolveLocalMediaPath } from '@/lib/media'

// Proxy from /api/render-proxy/[...path] to the ffmpeg-renderer mini-service at localhost:3003
// Avoids CORS issues and keeps the mini-service internal.
//
// Two input modes for renders (POST /render):
//   1. multipart passthrough — the client uploads the source video (Upload tab)
//   2. JSON { recipe, projectId } — the renderer input is the server-side media
//      persisted on the owned project (downloaded YouTube source / upload kept
//      by the transcribe job). The proxy resolves the path from the DB (the
//      client NEVER sends a path), validates ownership + path containment, and
//      re-builds the multipart request — the renderer contract is unchanged.

const RENDERER_BASE = 'http://localhost:3003'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// render starts are expensive → rate limit (Phase 11); job polling stays cheap
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`render:${ip}`, 6, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded — too many renders. Please wait a minute.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }
  const { path } = await ctx.params
  const targetPath = '/' + path.join('/')
  const url = new URL(req.url)
  const targetUrl = RENDERER_BASE + targetPath + (url.search || '')

  const contentType = req.headers.get('content-type') ?? ''
  let body: BodyInit
  const headers: Record<string, string> = {}
  let rawBody: string | null = null
  let recipeJson: string | null = null
  if (contentType.includes('application/json') && targetPath === '/render') {
    // ---- JSON mode: project-source render (server-side media) ----
    rawBody = await req.text()
    let parsed: { recipe?: unknown; projectId?: unknown } = {}
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : ''
    recipeJson = typeof parsed.recipe === 'string' ? parsed.recipe : null
    if (!projectId || !recipeJson) {
      return NextResponse.json({ error: 'projectId and recipe are required' }, { status: 400 })
    }
    const ownerId = await getOrCreateSessionId()
    const project = await db.project.findFirst({
      where: { id: projectId, ownerId },
      select: { localMedia: true, localMediaState: true, localMediaSize: true, title: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
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
    if (sizeBytes > 1500 * 1024 * 1024) {
      return NextResponse.json({ error: 'Stored source media exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    try {
      const buf = await readFileAsync(absolute)
      const mime = mediaMimeForExt(absolute.split('.').pop() ?? '') ?? 'video/mp4'
      const form = new FormData()
      form.append('video', new Blob([new Uint8Array(buf)], { type: mime }), basename(absolute))
      form.append('recipe', recipeJson)
      body = form
      // forwarded multipart — no content-type header needed (fetch sets the boundary)
    } catch {
      return NextResponse.json({ error: 'Could not read stored source media' }, { status: 500 })
    }
  } else if (contentType.includes('multipart/form-data')) {
    // forward multipart as-is
    body = await req.blob()
    headers['content-type'] = contentType
  } else {
    rawBody = await req.text()
    body = rawBody
    headers['content-type'] = contentType || 'application/json'
  }

  // usage metering: a render START is the billable action (best-effort, never blocks the render)
  // NOTE: the renderer's create endpoint is POST /render (the legacy '/jobs'
  // match never fired — renders were silently unmetered; fixed)
  if (targetPath === '/render') {
    try {
      const ownerId = await getOrCreateSessionId()
      let renderSeconds: number | undefined
      try {
        const parsed = JSON.parse(recipeJson ?? rawBody ?? '') as { output_duration?: number }
        renderSeconds = isFinite(Number(parsed?.output_duration)) ? Number(parsed.output_duration) : undefined
      } catch { /* multipart body; quantity=1 still recorded */ }
      void recordUsage(ownerId, 'render', 1, { renderSeconds })
    } catch { /* session issues must not block rendering */ }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body,
    })
    const respBody = await upstream.arrayBuffer()
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
    return new NextResponse(respBody, {
      status: upstream.status,
      headers: { 'content-type': ct },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'proxy failed' }, { status: 502 })
  }
}

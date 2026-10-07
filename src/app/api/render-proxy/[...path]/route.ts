import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@/lib/validation'
import { getOrCreateSessionId } from '@/lib/session'
import { recordUsage } from '@/lib/usage'

// Proxy from /api/render-proxy/[...path] to the ffmpeg-renderer mini-service at localhost:3003
// Avoids CORS issues and keeps the mini-service internal.

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
  if (contentType.includes('multipart/form-data')) {
    // forward multipart as-is
    body = await req.blob()
    headers['content-type'] = contentType
  } else {
    rawBody = await req.text()
    body = rawBody
    headers['content-type'] = contentType || 'application/json'
  }

  // usage metering: a render START is the billable action (best-effort, never blocks the render)
  if (targetPath === '/jobs' || targetPath === '/jobs/') {
    try {
      const ownerId = await getOrCreateSessionId()
      let renderSeconds: number | undefined
      try {
        const parsed = JSON.parse(rawBody ?? '') as { output_duration?: number }
        renderSeconds = isFinite(Number(parsed?.output_duration)) ? Number(parsed.output_duration) : undefined
      } catch { /* body may be multipart; quantity=1 still recorded */ }
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

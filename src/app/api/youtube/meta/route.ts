import { NextRequest, NextResponse } from 'next/server'
import { extractYouTubeId, resolveYoutubeMeta } from '@/lib/media'
import { checkRateLimit, rateLimitHeaders } from '@/lib/validation'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/youtube/meta — health/info
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'POST { url } to resolve REAL video metadata (duration via yt-dlp → innertube; never guessed).',
  })
}

/**
 * POST /api/youtube/meta
 * Resolves REAL metadata. If the real duration cannot be obtained the response
 * contains duration: null + durationSource: 'unavailable' + requiresManualDuration.
 * This endpoint NEVER returns a guessed duration.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`meta:${ip}`, 30, 60_000)
  const headers = rateLimitHeaders(rl, 30)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait a moment before trying again.' },
      { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const body = await req.json().catch(() => ({}))
    const rawUrl: string = (body?.url ?? '').trim()
    if (!rawUrl) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400, headers })
    }
    const youtubeId = extractYouTubeId(rawUrl)
    if (!youtubeId) {
      return NextResponse.json(
        { error: 'Invalid YouTube URL. Please paste a valid video link.' },
        { status: 400, headers },
      )
    }

    const meta = await resolveYoutubeMeta(rawUrl)

    return NextResponse.json(
      {
        youtubeId: meta.youtubeId,
        url: meta.url,
        title: meta.title,
        author: meta.author,
        thumbnail: meta.thumbnail,
        provider: meta.provider,
        duration: meta.duration, // may be null — callers must not fake it
        durationSource: meta.durationSource,
        requiresManualDuration: meta.duration === null,
        resolverErrors: meta.resolverErrors,
        embedUrl: `https://www.youtube.com/embed/${meta.youtubeId}`,
        embedUrlAutoplay: `https://www.youtube.com/embed/${meta.youtubeId}?autoplay=1&rel=0`,
      },
      { headers },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502, headers })
  }
}

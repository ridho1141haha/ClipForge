import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/projects — ONLY the current session's projects.
 */
export async function GET() {
  try {
    const ownerId = await getOrCreateSessionId()
    const projects = await db.project.findMany({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { clips: true } } },
    })
    return NextResponse.json({ projects })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST /api/projects — create a project owned by the current session.
 * Accepts REAL duration + durationSource (never a guessed value).
 */
export async function POST(req: NextRequest) {
  try {
    const ownerId = await getOrCreateSessionId()
    const body = await req.json()
    const { youtubeId, url, title, author, thumbnail, description, duration, durationSource, transcript, transcriptSource } = body
    if (!youtubeId || !url || !title) {
      return NextResponse.json({ error: 'youtubeId, url, title are required' }, { status: 400 })
    }
    const dur = Number(duration)
    const validDuration = isFinite(dur) && dur > 0 ? dur : null
    const project = await db.project.create({
      data: {
        ownerId,
        youtubeId,
        url,
        title,
        author: author ?? null,
        thumbnail: thumbnail ?? null,
        description: description ?? null,
        duration: validDuration,
        durationSource: validDuration === null ? 'unavailable' : String(durationSource ?? 'unavailable'),
        transcript: typeof transcript === 'string' && transcript.trim() ? transcript.trim().slice(0, 400_000) : null,
        transcriptSource: typeof transcriptSource === 'string' ? transcriptSource : transcript ? 'manual' : 'none',
        status: 'new',
      },
    })
    return NextResponse.json({ project })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

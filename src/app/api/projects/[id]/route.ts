import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/projects/[id] — owner-scoped. Another user's ID → 404.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const project = await db.project.findFirst({
      where: { id, ownerId },
      include: { clips: { orderBy: { order: 'asc' } } },
    })
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ project })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * PATCH /api/projects/[id] — owner-scoped.
 * Accepts REAL duration updates (durationSource must be honest).
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    // ensure ownership BEFORE updating
    const existing = await db.project.findFirst({ where: { id, ownerId }, select: { id: true } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (body.title !== undefined) data.title = String(body.title).slice(0, 300)
    if (body.status !== undefined) data.status = String(body.status).slice(0, 40)
    if (body.duration !== undefined) {
      const d = Number(body.duration)
      if (isFinite(d) && d > 0) {
        data.duration = d
        data.durationSource = String(body.durationSource ?? 'user-provided')
      } else if (body.duration === null) {
        data.duration = null
        data.durationSource = 'unavailable'
      }
    }
    if (body.transcript !== undefined) {
      data.transcript = typeof body.transcript === 'string' && body.transcript.trim() ? body.transcript.trim().slice(0, 400_000) : null
      if (typeof body.transcriptSource === 'string') data.transcriptSource = body.transcriptSource
    }
    const project = await db.project.update({ where: { id }, data })
    return NextResponse.json({ project })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * DELETE /api/projects/[id] — owner-scoped.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const existing = await db.project.findFirst({ where: { id, ownerId }, select: { id: true } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await db.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

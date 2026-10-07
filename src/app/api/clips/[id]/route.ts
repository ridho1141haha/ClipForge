import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/clips/[id] — owner-scoped via the parent project.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const clip = await db.clip.findFirst({ where: { id, project: { ownerId } }, include: { project: true } })
    if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ clip })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * PATCH /api/clips/[id] — owner-scoped via the parent project.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const existing = await db.clip.findFirst({ where: { id, project: { ownerId } }, select: { id: true } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (body.title !== undefined) data.title = body.title
    if (body.summary !== undefined) data.summary = body.summary
    if (body.startTime !== undefined) data.startTime = Number(body.startTime)
    if (body.endTime !== undefined) data.endTime = Number(body.endTime)
    if (body.score !== undefined) data.score = Number(body.score)
    if (body.tags !== undefined) data.tags = Array.isArray(body.tags) ? JSON.stringify(body.tags) : body.tags
    if (body.hookText !== undefined) data.hookText = body.hookText
    if (body.spokenHook !== undefined) data.spokenHook = body.spokenHook
    if (body.hookVerified !== undefined) data.hookVerified = Boolean(body.hookVerified)
    if (body.platform !== undefined) data.platform = body.platform
    if (body.status !== undefined) data.status = body.status
    if (body.order !== undefined) data.order = Number(body.order)
    if (body.style !== undefined) data.style = body.style
    if (body.targetDuration !== undefined) data.targetDuration = Number(body.targetDuration)
    if (body.scores !== undefined) data.scores = JSON.stringify(body.scores)
    if (body.contextRisk !== undefined) data.contextRisk = Boolean(body.contextRisk)
    if (body.contextStatus !== undefined) data.contextStatus = body.contextStatus
    if (body.recommendation !== undefined) data.recommendation = body.recommendation
    if (body.generatedHook !== undefined) data.generatedHook = body.generatedHook
    if (body.reason !== undefined) data.reason = body.reason
    if (body.clipTranscript !== undefined) data.clipTranscript = body.clipTranscript
    if (body.clipWords !== undefined) data.clipWords = JSON.stringify(body.clipWords)
    if (body.segments !== undefined) data.segments = JSON.stringify(body.segments)
    if (body.cuts !== undefined) data.cuts = JSON.stringify(body.cuts)
    if (body.camera !== undefined) data.camera = JSON.stringify(body.camera)
    if (body.visuals !== undefined) data.visuals = JSON.stringify(body.visuals)
    if (body.animations !== undefined) data.animations = JSON.stringify(body.animations)
    if (body.soundEffects !== undefined) data.soundEffects = JSON.stringify(body.soundEffects)
    if (body.music !== undefined) data.music = JSON.stringify(body.music)
    if (body.subtitles !== undefined) data.subtitles = JSON.stringify(body.subtitles)
    if (body.hasPlan !== undefined) data.hasPlan = Boolean(body.hasPlan)

    const updated = await db.clip.update({ where: { id }, data })
    return NextResponse.json({ clip: updated })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * DELETE /api/clips/[id] — owner-scoped; recount inside a transaction.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { id } = await ctx.params
    const existing = await db.clip.findFirst({ where: { id, project: { ownerId } }, select: { id: true, projectId: true } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await db.$transaction(async (tx) => {
      await tx.clip.delete({ where: { id } })
      const realCount = await tx.clip.count({ where: { projectId: existing.projectId } })
      await tx.project.update({ where: { id: existing.projectId }, data: { clipCount: realCount } })
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ClipInput {
  projectId: string
  title: string
  summary?: string
  startTime: number
  endTime: number
  score?: number
  tags?: string[]
  hookText?: string
  spokenHook?: string
  hookVerified?: boolean
  platform?: string
  status?: string
  order?: number
  style?: string
  targetDuration?: number
  scores?: Record<string, number>
  contextRisk?: boolean
  contextStatus?: string
  recommendation?: string
  generatedHook?: string
  reason?: string
  clipTranscript?: string
  clipWords?: unknown
  segments?: unknown
  cuts?: unknown
  camera?: unknown
  visuals?: unknown
  animations?: unknown
  soundEffects?: unknown
  music?: unknown
  subtitles?: unknown
  hasPlan?: boolean
}

function clipData(c: ClipInput, idx: number) {
  return {
    projectId: c.projectId,
    title: String(c.title ?? `Clip ${idx + 1}`).slice(0, 200),
    summary: c.summary ?? null,
    startTime: Number(c.startTime) || 0,
    endTime: Number(c.endTime) || 0,
    score: Number(c.score) || 0,
    tags: c.tags ? JSON.stringify(c.tags) : null,
    hookText: c.hookText ?? c.spokenHook ?? null,
    spokenHook: c.spokenHook ?? c.hookText ?? null,
    hookVerified: Boolean(c.hookVerified),
    platform: c.platform ?? 'shorts',
    status: c.status ?? 'suggested',
    order: c.order ?? idx,
    style: c.style ?? null,
    targetDuration: c.targetDuration ?? null,
    scores: c.scores ? JSON.stringify(c.scores) : null,
    contextRisk: Boolean(c.contextRisk),
    contextStatus: c.contextStatus ?? null,
    recommendation: c.recommendation ?? null,
    generatedHook: c.generatedHook ?? null,
    reason: c.reason ?? null,
    clipTranscript: c.clipTranscript ?? null,
    clipWords: c.clipWords ? JSON.stringify(c.clipWords) : null,
    segments: c.segments ? JSON.stringify(c.segments) : null,
    cuts: c.cuts ? JSON.stringify(c.cuts) : null,
    camera: c.camera ? JSON.stringify(c.camera) : null,
    visuals: c.visuals ? JSON.stringify(c.visuals) : null,
    animations: c.animations ? JSON.stringify(c.animations) : null,
    soundEffects: c.soundEffects ? JSON.stringify(c.soundEffects) : null,
    music: c.music ? JSON.stringify(c.music) : null,
    subtitles: c.subtitles ? JSON.stringify(c.subtitles) : null,
    hasPlan: Boolean(c.hasPlan),
  }
}

/**
 * GET /api/clips — REQUIRES projectId, and the project must belong to the session.
 * Never returns other users' clips (Phase 10 fix).
 */
export async function GET(req: NextRequest) {
  try {
    const ownerId = await getOrCreateSessionId()
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required — listing all clips is not allowed' }, { status: 400 })
    }
    const project = await db.project.findFirst({ where: { id: projectId, ownerId }, select: { id: true } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const clips = await db.clip.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      include: { project: { select: { title: true, thumbnail: true } } },
    })
    return NextResponse.json({ clips })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST /api/clips — bulk replace (transactional) or single create.
 * SECURITY: project must belong to the current session.
 * Phase 12: delete + create + count update happen inside ONE transaction.
 */
export async function POST(req: NextRequest) {
  try {
    const ownerId = await getOrCreateSessionId()
    const body = await req.json()

    if (Array.isArray(body)) {
      const items: ClipInput[] = body
      if (items.length === 0) return NextResponse.json({ error: 'Empty clip array' }, { status: 400 })
      const pid = items[0].projectId
      if (!pid) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

      // ownership check BEFORE touching data
      const project = await db.project.findFirst({ where: { id: pid, ownerId }, select: { id: true } })
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

      // ONE transaction: replace all clips atomically (fixes data-loss bug)
      const created = await db.$transaction(async (tx) => {
        await tx.clip.deleteMany({ where: { projectId: pid } })
        const rows: { id: string }[] = []
        for (let idx = 0; idx < items.length; idx++) {
          const row = await tx.clip.create({ data: clipData(items[idx], idx), select: { id: true } })
          rows.push(row)
        }
        await tx.project.update({
          where: { id: pid },
          data: { status: 'analyzed', clipCount: rows.length },
        })
        return rows
      })
      return NextResponse.json({ count: created.length })
    }

    // single create
    const c: ClipInput = body
    if (!c.projectId || !c.title) {
      return NextResponse.json({ error: 'projectId and title required' }, { status: 400 })
    }
    const project = await db.project.findFirst({ where: { id: c.projectId, ownerId }, select: { id: true } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const clip = await db.$transaction(async (tx) => {
      const created = await tx.clip.create({ data: clipData(c, 0) })
      const realCount = await tx.clip.count({ where: { projectId: c.projectId } })
      await tx.project.update({
        where: { id: c.projectId },
        data: { clipCount: realCount, status: 'analyzed' },
      })
      return created
    })
    return NextResponse.json({ clip })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

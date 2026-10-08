import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { checkRateLimit, rateLimitHeaders } from '@/lib/validation'
import { buildKeepRanges, buildSrt, buildVtt, sourceToOutputTime, type Cut, type SubtitleBlock, type Word } from '@/lib/subtitles'
import { RENDER_QUALITY_PRESETS } from '@/lib/render-recipe'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** export-JSON preset facts — DERIVED from the shared RENDER_QUALITY_PRESETS
 *  (drops the internal videoPreset field; downstream tools get the
 *  user-facing encoder contract). Single source of truth: changing the preset
 *  table updates every export automatically. */
const EXPORT_PRESETS = Object.fromEntries(
  Object.entries(RENDER_QUALITY_PRESETS).map(([k, p]) => [
    k,
    { width: p.width, height: p.height, crf: p.crf, audioBitrate: p.audioBitrate, fps: p.fps },
  ]),
)

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec2 = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec2)}` : `${pad(m)}:${pad(sec2)}`
}

function safeParseArray<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function safeParseObj<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

type PlanClip = {
  id: string
  title: string
  summary: string | null
  startTime: number
  endTime: number
  score: number
  tags: string | null
  hookText: string | null
  spokenHook: string | null
  hookVerified: boolean
  generatedHook: string | null
  platform: string
  style: string | null
  status: string
  recommendation: string | null
  contextRisk: boolean
  contextStatus: string | null
  reason: string | null
  clipTranscript: string | null
  clipWords: string | null
  scores: string | null
  segments: string | null
  cuts: string | null
  camera: string | null
  visuals: string | null
  animations: string | null
  soundEffects: string | null
  music: string | null
  subtitles: string | null
  hasPlan: boolean
  order: number
}

/**
 * Build REAL subtitles for a clip: prefer the transcript-grounded plan subtitles,
 * else rebuild deterministically from word timestamps. Returns OUTPUT-time blocks.
 */
function clipSubtitlesOutputTime(clip: PlanClip): SubtitleBlock[] {
  const cuts = safeParseArray<Cut>(clip.cuts).filter((c) => c.end > c.start)
  const planSubs = safeParseArray<SubtitleBlock & { emphasis_words?: string[] }>(clip.subtitles)
  if (planSubs.length > 0) {
    // plan subtitles are SOURCE time → map to OUTPUT time, dropping cut-covered blocks
    return planSubs
      .map((s) => ({
        start: sourceToOutputTime(s.start, clip.startTime, cuts),
        end: sourceToOutputTime(s.end, clip.startTime, cuts),
        text: s.text,
        emphasis_words: s.emphasis_words ?? [],
        emphasis_type: s.emphasis_type,
      }))
      .filter((s) => s.end > s.start + 0.1)
  }
  // no plan → build from clip word timestamps (real speech, grouped)
  const words = safeParseArray<Word>(clip.clipWords)
  if (words.length === 0) return []
  const keep = buildKeepRanges(clip.startTime, clip.endTime, cuts)
  const blocks: SubtitleBlock[] = []
  const inRange = words
    .filter((w) => w.end > clip.startTime && w.start < clip.endTime)
    .map((w) => ({ ...w, start: Math.max(w.start, clip.startTime), end: Math.min(w.end, clip.endTime) }))
    .sort((a, b) => a.start - b.start)
  // group into ~6-word chunks
  let group: Word[] = []
  const flush = () => {
    if (group.length === 0) return
    const gStart = group[0].start
    const gEnd = group[group.length - 1].end
    const inKeep = keep.some((r) => Math.min(gEnd, r.end) - Math.max(gStart, r.start) > (gEnd - gStart) * 0.5)
    if (inKeep) {
      blocks.push({
        start: sourceToOutputTime(gStart, clip.startTime, cuts),
        end: sourceToOutputTime(gEnd, clip.startTime, cuts),
        text: group.map((w) => w.word).join(' '),
        emphasis_words: [],
      })
    }
    group = []
  }
  for (const w of inRange) {
    group.push(w)
    if (group.length >= 6 || /[.!?…]$/.test(w.word)) flush()
  }
  flush()
  return blocks
}

export async function POST(req: NextRequest) {
  const rl = checkRateLimit('export', 30, 60_000)
  const rlHeaders = rateLimitHeaders(rl, 30)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: rlHeaders })
  }
  try {
    const ownerId = await getOrCreateSessionId()
    const body = await req.json()
    const projectId: string = body.projectId
    const format: 'json' | 'csv' | 'srt' | 'vtt' | 'edl' = body.format ?? 'json'
    const clipId: string | undefined = body.clipId
    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400, headers: rlHeaders })
    }
    // SECURITY: ownership enforced
    const project = await db.project.findFirst({
      where: { id: projectId, ownerId },
      include: { clips: { orderBy: { order: 'asc' } } },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404, headers: rlHeaders })

    const clips = (clipId ? project.clips.filter((c) => c.id === clipId) : project.clips) as unknown as PlanClip[]
    const analysisMeta = safeParseObj<{ model: string; provider: string; promptVersion: string; analysisVersion: string; analyzedAt: string }>(project.analysisMeta)

    let content = ''
    let mime = 'application/json'
    let ext = 'json'

    if (format === 'json') {
      content = JSON.stringify(
        {
          project: {
            id: project.id,
            title: project.title,
            url: project.url,
            youtubeId: project.youtubeId,
            author: project.author,
            duration: project.duration, // REAL seconds (may be null — never guessed)
            durationSource: project.durationSource,
            transcriptSource: project.transcriptSource,
            transcript: project.transcript
              ? { source: project.transcriptSource, charCount: project.transcript.length, text: project.transcript.slice(0, 100_000) }
              : null,
          },
          analysis: analysisMeta
            ? {
                model: analysisMeta.model,
                provider: analysisMeta.provider,
                promptVersion: analysisMeta.promptVersion,
                analysisVersion: analysisMeta.analysisVersion,
                analyzedAt: analysisMeta.analyzedAt,
              }
            : null,
          renderSettings: {
            fps: RENDER_QUALITY_PRESETS.standard.fps,
            videoCodec: 'libx264 (H.264)',
            audioCodec: 'aac',
            aspect: '9:16 vertical',
            // real per-quality encoder settings — derived from the SHARED
            // RENDER_QUALITY_PRESETS (single source of truth with the renderer
            // mirror in src/lib/render-recipe.ts; the old inline literal here
            // once drifted from the renderer contract)
            presets: EXPORT_PRESETS,
          },
          rendererCapabilities: {
            rendered: ['cuts', 'subtitles_burn_in', 'camera_punch_in', '9:16_crop_scale', 'h264+aac_encode'],
            preview_only: ['broll_visuals', 'generated_images', 'animations', 'sound_effects', 'music'],
          },
          clips: clips.map((c) => ({
            id: c.id,
            title: c.title,
            summary: c.summary,
            startTime: c.startTime,
            endTime: c.endTime,
            duration: +(c.endTime - c.startTime).toFixed(1),
            score: c.score, // server-calculated 0-100
            scores: safeParseObj(c.scores) ?? undefined,
            tags: safeParseArray<string>(c.tags),
            spokenHook: c.spokenHook ?? c.hookText ?? null,
            hookVerified: c.hookVerified,
            generatedHook: c.generatedHook,
            platform: c.platform,
            style: c.style,
            status: c.status,
            recommendation: c.recommendation,
            contextRisk: c.contextRisk,
            contextStatus: c.contextStatus,
            reason: c.reason,
            transcriptExcerpt: c.clipTranscript,
            clipWords: safeParseArray<Word>(c.clipWords),
            segments: safeParseArray(c.segments).length ? safeParseArray(c.segments) : undefined,
            cuts: safeParseArray(c.cuts).length ? safeParseArray(c.cuts) : undefined,
            camera: safeParseArray(c.camera).length ? safeParseArray(c.camera) : undefined,
            visuals: safeParseArray(c.visuals).length ? safeParseArray(c.visuals) : undefined,
            animations: safeParseArray(c.animations).length ? safeParseArray(c.animations) : undefined,
            soundEffects: safeParseArray(c.soundEffects).length ? safeParseArray(c.soundEffects) : undefined,
            music: safeParseObj(c.music) ?? undefined,
            subtitles: safeParseArray(c.subtitles).length ? safeParseArray(c.subtitles) : undefined,
            hasPlan: c.hasPlan,
            keepRanges: buildKeepRanges(c.startTime, c.endTime, safeParseArray<Cut>(c.cuts)),
          })),
          exportedAt: new Date().toISOString(),
          exportVersion: '3.0',
        },
        null,
        2,
      )
      mime = 'application/json'
    } else if (format === 'srt' || format === 'vtt') {
      // REAL subtitles from transcript content — per-clip, output-time
      const blocks: SubtitleBlock[] = []
      for (const c of clips) {
        const subs = clipSubtitlesOutputTime(c)
        if (subs.length > 0) {
          // when exporting multiple clips, offset each clip's subtitles by cumulative output duration
          const offset = blocks.reduce((acc, b) => Math.max(acc, b.end), 0)
          blocks.push(...subs.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset })))
        }
      }
      if (blocks.length === 0) {
        return NextResponse.json(
          { error: 'No transcript-based subtitles available. Generate an edit plan with a transcript (or provide word timestamps) first — ClipForge does not fabricate subtitle text from titles.' },
          { status: 422, headers: rlHeaders },
        )
      }
      content = format === 'srt' ? buildSrt(blocks) : buildVtt(blocks)
      mime = format === 'srt' ? 'application/x-subrip' : 'text/vtt'
      ext = format
    } else if (format === 'csv') {
      const rows = [
        ['index', 'title', 'startTime', 'endTime', 'duration', 'startTimeStr', 'endTimeStr', 'score', 'platform', 'status', 'recommendation', 'contextStatus', 'hookVerified', 'spokenHook', 'tags', 'summary'],
      ]
      clips.forEach((c, i) => {
        rows.push([
          String(i + 1),
          csvEsc(c.title),
          String(c.startTime),
          String(c.endTime),
          (c.endTime - c.startTime).toFixed(1),
          fmtTime(c.startTime),
          fmtTime(c.endTime),
          String(c.score),
          c.platform,
          c.status,
          c.recommendation ?? '',
          c.contextStatus ?? '',
          c.hookVerified ? 'yes' : 'no',
          csvEsc(c.spokenHook ?? c.hookText ?? ''),
          csvEsc(safeParseArray<string>(c.tags).join('|')),
          csvEsc(c.summary ?? ''),
        ])
      })
      content = rows.map((r) => r.join(',')).join('\n')
      mime = 'text/csv'
      ext = 'csv'
    } else if (format === 'edl') {
      const lines = [
        `TITLE: ${project.title}`,
        `SOURCE: ${project.url}`,
        `FCM: NON-DROP FRAME`,
        '',
      ]
      clips.forEach((c, i) => {
        const cuts = safeParseArray<Cut>(c.cuts)
        if (cuts.length > 0) {
          for (const keep of buildKeepRanges(c.startTime, c.endTime, cuts)) {
            lines.push(`${String(i + 1).padStart(3, '0')}  AX  AA/V  C        ${fmtEdl(keep.start)} ${fmtEdl(keep.end)} ${fmtEdl(keep.start)} ${fmtEdl(keep.start + (keep.end - keep.start))}`)
          }
        } else {
          lines.push(`${String(i + 1).padStart(3, '0')}  AX  AA/V  C        ${fmtEdl(c.startTime)} ${fmtEdl(c.endTime)} ${fmtEdl(c.startTime)} ${fmtEdl(c.endTime)}`)
        }
        lines.push(`* FROM CLIP NAME: ${c.title}`)
        if (c.spokenHook) lines.push(`* COMMENT: ${c.hookVerified ? '[verified] ' : '[unverified] '}${c.spokenHook}`)
        lines.push('')
      })
      content = lines.join('\n')
      mime = 'text/plain'
      ext = 'edl'
    }

    const safeTitle = project.title.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 50)
    const filename = `clipforge_${safeTitle}_${Date.now()}.${ext}`
    return new NextResponse(content, {
      status: 200,
      headers: {
        'Content-Type': mime + '; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500, headers: rlHeaders })
  }
}

function csvEsc(s: string): string {
  if (s == null) return ''
  const needs = /[",\n]/.test(s)
  return needs ? `"${s.replace(/"/g, '""')}"` : s
}

function fmtEdl(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const secInt = Math.floor(s % 60)
  const frames = Math.round((s - Math.floor(s)) * 30)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${pad(h)}:${pad(m)}:${pad(secInt)}:${pad(frames)}`
}

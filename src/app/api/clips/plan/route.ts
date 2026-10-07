import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { STYLE_PRESETS, type EditPlan, type SubtitleBlock } from '@/lib/editplan'
import { EditPlanSchema, checkRateLimit, extractJsonObject, rateLimitHeaders, validateHookAgainstTranscript, normalizeText, type Word as TWord } from '@/lib/validation'
import { groupWordsIntoBlocks } from '@/lib/subtitles'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const PROMPT_VERSION = 'plan-v3-grounded'

interface WordInput { word: string; start: number; end: number }

interface PlanBody {
  title: string
  author?: string | null
  videoDuration: number // REQUIRED real duration
  clipId: string
  clipStart: number
  clipEnd: number
  clipTitle: string
  spokenHook?: string
  clipReason?: string
  clipScores?: {
    hook: number
    curiosity: number
    emotion: number
    payoff: number
    standalone: number
    shareability: number
    context_safety: number
    total: number
  }
  clipTranscript?: string // REAL spoken content inside the clip
  clipWords?: WordInput[] // word-level timestamps (source time)
  sourceDuration?: number
  platform: string
  style: string
  targetDuration: number
  language?: string
  projectId?: string // ownership check when persisting
  persist?: boolean
}

function buildSystemPrompt(platform: string, style: string, targetDuration: number, language: string, hasTranscript: boolean): string {
  const sp = STYLE_PRESETS.find((s) => s.id === style)
  const styleDesc = sp ? `${sp.label}: ${sp.desc}` : style
  const LANG_MAP: Record<string, string> = {
    auto: 'the source video original language', en: 'English', id: 'Bahasa Indonesia', es: 'Spanish',
    pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', ru: 'Russian',
    ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', ms: 'Malay',
  }
  const langName = LANG_MAP[language] ?? LANG_MAP.auto
  const langRule =
    language === 'auto'
      ? `All generated text (purposes, reasons, generated_hook) MUST be in the SAME language as the clip transcript.`
      : `All generated text (purposes, reasons, generated_hook) MUST be written in ${langName}. Subtitle text MUST stay verbatim from the transcript (do NOT translate speech).`

  const subtitleRule = hasTranscript
    ? `STAGE 5 — SUBTITLE GENERATION (TRANSCRIPT-LOCKED):
Subtitles MUST be built from the CLIP TRANSCRIPT provided below. You decide grouping (3-7 words per block), line breaks, emphasis_words, and emphasis_type. Every subtitle "text" MUST be the exact spoken words from the clip transcript for that time window — you may split/join word groups but you MUST NOT alter, summarize, translate, or invent any spoken word.`
    : `STAGE 5 — SUBTITLE GENERATION:
NO transcript is available for this clip. You MUST return "subtitles": [] — do NOT invent subtitle text under any circumstances.`

  return `You are ClipForge AI, an expert short-form video editor and AI creative director. You produce a precise structured EDIT PLAN that a video rendering engine executes.

Priorities (in order): Retention, Strong hook, Clear context, Emotional/informational payoff, Natural pacing, Visual variety, Readable subtitles, Accurate representation of the speaker, Avoiding misleading edits.

Editing style: ${styleDesc}
Target platform: ${platform} (vertical 9:16)
Target clip duration: ~${targetDuration}s.

LANGUAGE REQUIREMENT:
${langRule}

STAGE 3 — HOOK OPTIMIZATION:
The first 1-3 seconds are critical. Prefer starting directly with the strongest sentence using CUTS (you may cut silence/filler at the start of the clip window). NEVER remove words in a way that changes the speaker's meaning. Do not invent spoken dialogue. The on-screen hook is separate: put it in "generated_hook" and clearly treat it as generated text.

STAGE 4 — EDIT STRUCTURE:
Divide the clip timeline into semantic segments. Possible types: HOOK, CONTEXT, DEVELOPMENT, EXAMPLE, CONTRAST, PAYOFF, CTA. Every segment must contain start, end, purpose, subtitle (verbatim spoken text in that segment — only if transcript is provided), emphasis_words.

${subtitleRule}

STAGE 6 — AUTO PUNCH-IN / CAMERA MOVEMENT:
Subtle camera movement. Default scale 1.00. Punch-in 1.05-1.12. Strong emphasis 1.12-1.18. Each camera move: start, end, scale_start, scale_end, reason.

STAGE 7 — VISUAL INSERTION (RECOMMENDATION ONLY):
Request a visual ONLY when it adds value. Types: generated_image|broll|screenshot|diagram|icon|text_card|meme|infographic|stock_footage. NOTE: visuals are recommendations for a human editor / future renderer — they are NOT burned into the rendered MP4.

STAGE 8 — ANIMATION (RECOMMENDATION ONLY):
Types: fade, slide, pop, scale, bounce, typewriter, word_emphasis, kinetic_typography, freeze_frame, highlight_box, arrow, underline, progress_indicator. NOTE: animations are preview/recommendation only.

STAGE 9 — SOUND DESIGN (RECOMMENDATION ONLY):
Sound effects only when appropriate (whoosh, impact, pop, click, bass_hit, notification, record_scratch, crowd_reaction). Each: type, start, duration, intensity (0-1). For music: recommended (bool), style, intensity (0-1), ducking_percent (0-100). NOTE: SFX/music are recommendations — the renderer does not mix audio effects yet.

STAGE 10 — PACING:
Detect long pauses, filler, repeated phrases, slow sections INSIDE the clip window. Recommend cuts. Do NOT remove pauses that create emotional impact. Each cut: start, end, reason. Cuts must stay inside the clip window and must not remove more than 40% of the clip.

STAGE 12 — CONTEXT SAFETY:
Ask: "Would a viewer understand the intended meaning from this clip alone?" If no, extend the clip within bounds or mark the risk.

RULES:
- Output STRICT JSON only. No markdown, no commentary.
- All timestamps refer to the ORIGINAL source video (absolute seconds), within the clip's [start, end] window.
- NEVER invent spoken dialogue. Subtitle text must be verbatim transcript content (when transcript is provided; otherwise return empty subtitles).
- Every cut, zoom, animation, visual must have a reason.
- Return the JSON object with this exact shape:
{
  "project": { "title": "", "style": "", "platform": "", "target_duration": 0, "aspect_ratio": "9:16" },
  "analysis": { "main_topic": "", "audience": "", "content_type": "", "overall_summary": "" },
  "selected_clip": {
    "id": "", "start": 0, "end": 0, "duration": 0, "title": "", "generated_hook": "",
    "segments": [ { "type": "HOOK", "start": 0, "end": 0, "purpose": "", "subtitle": "", "emphasis_words": [] } ],
    "cuts": [ { "start": 0, "end": 0, "reason": "" } ],
    "camera": [ { "start": 0, "end": 0, "scale_start": 1.0, "scale_end": 1.08, "reason": "" } ],
    "visuals": [ { "type": "generated_image", "start": 0, "end": 0, "purpose": "", "prompt": "", "aspect_ratio": "9:16", "transition": "fade" } ],
    "animations": [ { "type": "word_emphasis", "start": 0, "end": 0, "text": "", "animation": "" } ],
    "sound_effects": [ { "type": "whoosh", "start": 0, "duration": 0.3, "intensity": 0.5 } ],
    "music": { "recommended": false, "style": "", "intensity": 0, "ducking_percent": 30 },
    "subtitles": [ { "start": 0, "end": 0, "text": "", "emphasis_words": [], "emphasis_type": "bold" } ]
  }
}

Return ONLY the JSON object.`
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`plan:${ip}`, 20, 60_000)
  const rlHeaders = rateLimitHeaders(rl, 20)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait a moment before trying again.' },
      { status: 429, headers: { ...rlHeaders, 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const ownerId = await getOrCreateSessionId()
    const body = (await req.json()) as PlanBody

    if (!body.title || !body.clipId) {
      return NextResponse.json({ error: 'title and clipId required' }, { status: 400, headers: rlHeaders })
    }
    const videoDuration = Number(body.videoDuration)
    if (!isFinite(videoDuration) || videoDuration <= 0) {
      return NextResponse.json({ error: 'Real videoDuration is required (no guessing).' }, { status: 400, headers: rlHeaders })
    }

    // ---------- ownership: resolve clip from DB when projectId given ----------
    let dbClip: { clipWords: string | null; clipTranscript: string | null; spokenHook: string | null } | null = null
    let dbProjectWords: TWord[] | null = null
    if (body.projectId) {
      const project = await db.project.findFirst({ where: { id: body.projectId, ownerId }, include: { clips: true } })
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404, headers: rlHeaders })
      }
      dbClip = project.clips.find((c) => c.id === body.clipId) ?? null
      if (project.transcriptWords) {
        try { dbProjectWords = JSON.parse(project.transcriptWords) as TWord[] } catch { dbProjectWords = null }
      }
    }

    const clipStart = Number(body.clipStart)
    const clipEnd = Number(body.clipEnd)
    if (!isFinite(clipStart) || !isFinite(clipEnd) || clipEnd <= clipStart) {
      return NextResponse.json({ error: 'Invalid clip time range' }, { status: 400, headers: rlHeaders })
    }

    // ---------- REAL transcript for the clip ----------
    let clipWords: TWord[] = []
    if (Array.isArray(body.clipWords) && body.clipWords.length > 0) {
      clipWords = body.clipWords.filter((w) => typeof w?.word === 'string' && isFinite(w?.start) && isFinite(w?.end)).map((w) => ({ word: w.word, start: Number(w.start), end: Number(w.end) }))
    } else if (dbClip?.clipWords) {
      try { clipWords = JSON.parse(dbClip.clipWords) as TWord[] } catch { /* ignore */ }
    } else if (dbProjectWords) {
      clipWords = dbProjectWords.filter((w) => w.end > clipStart && w.start < clipEnd)
    }
    const clipTranscript = (body.clipTranscript?.trim() || dbClip?.clipTranscript?.trim() || (clipWords.length > 0 ? clipWords.map((w) => w.word).join(' ') : '')) as string
    const hasTranscript = clipTranscript.length > 0

    const platform = body.platform || 'shorts'
    const style = body.style || 'podcast'
    const targetDuration = body.targetDuration || 45

    // ---------- LLM ----------
    const zai = await ZAI.create()
    const scores = body.clipScores
    const transcriptSection = hasTranscript
      ? `\nCLIP TRANSCRIPT (verbatim spoken content — subtitle text MUST come from this):\n"""\n${clipTranscript.slice(0, 8000)}\n"""` +
        (clipWords.length > 0
          ? `\nWORD TIMESTAMPS (source-time seconds):\n${clipWords.slice(0, 300).map((w) => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}] ${w.word}`).join(' ')}`
          : '')
      : `\nCLIP TRANSCRIPT: NONE AVAILABLE. Return "subtitles": [] and empty segment subtitle fields. Do NOT invent spoken text.`

    const userPrompt = `Produce the full EDIT PLAN for this selected candidate clip.

Source video: "${body.title}" by ${body.author ?? 'Unknown'}
Source duration: ${videoDuration}s (real)
Target platform: ${platform} (9:16), style: ${style}, target clip duration: ~${targetDuration}s

Selected candidate:
- id: ${body.clipId}
- title: "${body.clipTitle}"
- time range: ${clipStart}s → ${clipEnd}s (${(clipEnd - clipStart).toFixed(1)}s)
- spoken hook: "${body.spokenHook ?? dbClip?.spokenHook ?? ''}"
- reason selected: ${body.clipReason ?? ''}
${scores ? `- scores: hook=${scores.hook}/10 curiosity=${scores.curiosity}/10 emotion=${scores.emotion}/10 payoff=${scores.payoff}/10 standalone=${scores.standalone}/10 shareability=${scores.shareability}/10 context_safety=${scores.context_safety}/10 total=${scores.total}/100 (server-calculated)` : ''}
${transcriptSection}

Return the JSON object now. All timestamps must be absolute seconds within [${clipStart}, ${clipEnd}]. If any stage has no useful output, return an empty array for that field.`

    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: buildSystemPrompt(platform, style, targetDuration, body.language ?? 'auto', hasTranscript) },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: 'disabled' },
    })

    const raw = completion.choices[0]?.message?.content ?? ''

    // ---------- Phase 4/9: Zod validation of the edit plan ----------
    const parsed = extractJsonObject(raw)
    const zodResult = EditPlanSchema.safeParse(parsed)
    if (!zodResult.success) {
      return NextResponse.json(
        { error: 'AI edit plan failed schema validation.', issues: zodResult.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`) },
        { status: 502, headers: rlHeaders },
      )
    }
    const zodPlan = zodResult.data
    const sc = zodPlan.selected_clip

    // ---------- post-validation + deterministic repair ----------
    const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v * 10 : lo * 10) / 10))
    const clampScale = (v: number): number => Math.max(1.0, Math.min(1.18, Math.round((isFinite(v) ? v : 1.0) * 100) / 100))

    // cuts: keep inside clip, non-overlapping, cap total removal at 40%
    let cuts = sc.cuts
      .map((c) => ({ start: clampN(c.start, clipStart, clipEnd), end: clampN(c.end, clipStart, clipEnd), reason: String(c.reason ?? '').slice(0, 200) }))
      .filter((c) => c.end - c.start > 0.25)
      .sort((a, b) => a.start - b.start)
    const mergedCuts: typeof cuts = []
    for (const c of cuts) {
      const last = mergedCuts[mergedCuts.length - 1]
      if (last && c.start <= last.end) last.end = Math.max(last.end, c.end)
      else mergedCuts.push({ ...c })
    }
    cuts = mergedCuts
    const removed = cuts.reduce((a, c) => a + (c.end - c.start), 0)
    if (removed > (clipEnd - clipStart) * 0.4) {
      cuts = [] // over-aggressive plan → drop cuts entirely (safer)
    }

    // subtitles: repair with transcript-locked deterministic rebuild when AI text deviates
    let subtitles: SubtitleBlock[] = sc.subtitles.map((s) => ({
      start: clampN(s.start, clipStart, clipEnd),
      end: clampN(s.end, clipStart, clipEnd),
      text: String(s.text ?? '').slice(0, 300),
      emphasis_words: (s.emphasis_words ?? []).slice(0, 5).map((w) => String(w).slice(0, 40)),
      emphasis_type: s.emphasis_type as SubtitleBlock['emphasis_type'],
      // karaoke word timings ONLY when the AI text is exactly the real words in
      // its own window — otherwise omitted (never fabricate word timing)
      word_timings: alignWordTimings(String(s.text ?? ''), clipStart, clipEnd, clipWords, clampN(s.start, clipStart, clipEnd), clampN(s.end, clipStart, clipEnd)),
    })).filter((s) => s.end > s.start && s.text)

    let subtitlesSource: 'transcript' | 'deterministic' | 'none' = hasTranscript ? 'transcript' : 'none'
    if (hasTranscript) {
      // verify each AI subtitle against the clip transcript; drop fabricated lines
      const verified = subtitles.filter((s) => validateHookAgainstTranscript(s.text, clipTranscript).match)
      const mismatchRatio = subtitles.length > 0 ? 1 - verified.length / subtitles.length : 1
      if (mismatchRatio > 0.34 || verified.length === 0) {
        // deterministic rebuild from real word timestamps (guarantees no fabrication)
        // NOTE: plan subtitles stay in SOURCE time — the renderer maps to output time
        const emphasis = Array.from(new Set(sc.subtitles.flatMap((s) => s.emphasis_words ?? [])))
        const inRange = clipWords
          .filter((w) => w.end > clipStart && w.start < clipEnd)
          .map((w) => ({ ...w, start: Math.max(w.start, clipStart), end: Math.min(w.end, clipEnd) }))
          .sort((a, b) => a.start - b.start)
        subtitles = groupWordsIntoBlocks(inRange).map((b) => ({
          start: Math.round(b.start * 100) / 100,
          end: Math.round(b.end * 100) / 100,
          text: b.words.map((w) => w.word).join(' '),
          emphasis_words: emphasis.filter((e) => b.words.some((w) => w.word.toLowerCase().includes(String(e).toLowerCase()))).slice(0, 3),
          emphasis_type: 'bold' as const,
          // deterministic blocks are composed of real words by construction
          word_timings: b.words.map((w) => ({ word: w.word, start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 })),
        }))
        subtitlesSource = 'deterministic'
      } else if (verified.length < subtitles.length) {
        subtitles = verified
        subtitlesSource = 'transcript'
      }
    } else {
      subtitles = [] // no transcript → no subtitles, ever
      subtitlesSource = 'none'
    }

    const plan: EditPlan = {
      project: {
        title: String(zodPlan.project?.title ?? body.title).slice(0, 200),
        style: String(zodPlan.project?.style ?? style).slice(0, 40),
        platform: String(zodPlan.project?.platform ?? platform).slice(0, 40),
        target_duration: clampN(Number(zodPlan.project?.target_duration ?? targetDuration), 5, 600),
        aspect_ratio: '9:16',
      },
      analysis: {
        main_topic: String(zodPlan.analysis?.main_topic ?? '').slice(0, 200),
        audience: String(zodPlan.analysis?.audience ?? '').slice(0, 200),
        content_type: String(zodPlan.analysis?.content_type ?? '').slice(0, 120),
        overall_summary: String(zodPlan.analysis?.overall_summary ?? '').slice(0, 300),
      },
      selected_clip: {
        id: String(sc.id ?? body.clipId),
        start: clipStart,
        end: clipEnd,
        duration: Math.round((clipEnd - clipStart) * 10) / 10,
        title: String(sc.title ?? body.clipTitle).slice(0, 140),
        generated_hook: String(sc.generated_hook ?? '').slice(0, 200),
        segments: sc.segments.map((s) => ({
          type: String(s.type ?? 'HOOK').slice(0, 20) as EditPlan['selected_clip']['segments'][number]['type'],
          start: clampN(s.start, clipStart, clipEnd),
          end: clampN(s.end, clipStart, clipEnd),
          purpose: String(s.purpose ?? '').slice(0, 200),
          subtitle: String(s.subtitle ?? '').slice(0, 400),
          emphasis_words: (s.emphasis_words ?? []).map((w) => String(w).slice(0, 40)),
        })).filter((s) => s.end > s.start),
        cuts: cuts.map((c) => ({ start: c.start, end: c.end, reason: c.reason })),
        camera: sc.camera.map((c) => ({
          start: clampN(c.start, clipStart, clipEnd),
          end: clampN(c.end, clipStart, clipEnd),
          scale_start: clampScale(c.scale_start),
          scale_end: clampScale(c.scale_end),
          reason: String(c.reason ?? '').slice(0, 200),
        })).filter((c) => c.end > c.start),
        visuals: sc.visuals.map((v) => ({
          type: String(v.type ?? 'generated_image').slice(0, 30) as EditPlan['selected_clip']['visuals'][number]['type'],
          start: clampN(v.start, clipStart, clipEnd),
          end: clampN(v.end, clipStart, clipEnd),
          purpose: String(v.purpose ?? '').slice(0, 200),
          prompt: String(v.prompt ?? '').slice(0, 500),
          aspect_ratio: '9:16',
          transition: String(v.transition ?? 'fade').slice(0, 30),
        })).filter((v) => v.end > v.start),
        animations: sc.animations.map((a) => ({
          type: String(a.type ?? 'word_emphasis').slice(0, 30) as EditPlan['selected_clip']['animations'][number]['type'],
          start: clampN(a.start, clipStart, clipEnd),
          end: clampN(a.end, clipStart, clipEnd),
          text: String(a.text ?? '').slice(0, 100),
          animation: String(a.animation ?? '').slice(0, 100),
        })).filter((a) => a.end > a.start),
        sound_effects: sc.sound_effects.map((s) => ({
          type: String(s.type ?? 'whoosh').slice(0, 30),
          start: clampN(s.start, clipStart, clipEnd),
          duration: Math.max(0.1, Math.min(5, Number(s.duration) || 0.3)),
          intensity: Math.max(0, Math.min(1, Math.round((isFinite(s.intensity) ? s.intensity : 0.5) * 100) / 100)),
        })).filter((s) => s.start >= clipStart && s.start < clipEnd),
        music: sc.music
          ? {
              recommended: Boolean(sc.music.recommended),
              style: String(sc.music.style ?? '').slice(0, 80),
              intensity: Math.max(0, Math.min(1, Math.round((isFinite(sc.music.intensity) ? sc.music.intensity : 0) * 100) / 100)),
              ducking_percent: Math.max(0, Math.min(100, Number(sc.music.ducking_percent) || 30)),
            }
          : { recommended: false, style: '', intensity: 0, ducking_percent: 30 },
        subtitles,
      },
    }

    // ---------- persist plan (owner-scoped) ----------
    if (body.persist !== false && body.projectId) {
      const clip = await db.clip.findFirst({ where: { id: body.clipId, project: { id: body.projectId, ownerId } } })
      if (clip) {
        await db.clip.update({
          where: { id: clip.id },
          data: {
            segments: JSON.stringify(plan.selected_clip.segments),
            cuts: JSON.stringify(plan.selected_clip.cuts),
            camera: JSON.stringify(plan.selected_clip.camera),
            visuals: JSON.stringify(plan.selected_clip.visuals),
            animations: JSON.stringify(plan.selected_clip.animations),
            soundEffects: JSON.stringify(plan.selected_clip.sound_effects),
            music: JSON.stringify(plan.selected_clip.music),
            subtitles: JSON.stringify(plan.selected_clip.subtitles),
            generatedHook: plan.selected_clip.generated_hook || null,
            hasPlan: true,
          },
        })
      }
    }

    return NextResponse.json({
      plan,
      meta: {
        subtitlesSource,
        transcriptGrounded: hasTranscript,
        promptVersion: PROMPT_VERSION,
        clipWordCount: clipWords.length,
      },
    }, { headers: rlHeaders })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to generate edit plan'
    console.error('Plan error:', e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// silence unused-import lint if normalizeText becomes unnecessary later
void normalizeText

/**
 * Attach REAL word timings to an AI-authored subtitle block — but ONLY when
 * the block text is EXACTLY the words spoken inside its own window (punctuation
 * and case ignored). Returns undefined otherwise: karaoke timing is never
 * fabricated. `winStart`/`winEnd` are the clamped block bounds (SOURCE time).
 */
function alignWordTimings(
  text: string,
  clipStart: number,
  clipEnd: number,
  clipWords: TWord[],
  winStart: number,
  winEnd: number,
): { word: string; start: number; end: number }[] | undefined {
  if (!text.trim() || winEnd <= winStart || clipWords.length === 0) return undefined
  const inWindow = clipWords
    .filter((w) => w.end > winStart && w.start < winEnd)
    .sort((a, b) => a.start - b.start)
  if (inWindow.length < 2) return undefined
  const windowText = normalizeText(inWindow.map((w) => w.word).join(' '))
  if (!windowText || windowText !== normalizeText(text)) return undefined
  return inWindow.map((w) => ({
    word: w.word,
    start: Math.round(Math.max(w.start, clipStart) * 100) / 100,
    end: Math.round(Math.min(w.end, clipEnd) * 100) / 100,
  }))
}

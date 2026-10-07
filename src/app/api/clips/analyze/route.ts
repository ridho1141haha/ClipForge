import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { STYLE_PRESETS } from '@/lib/editplan'
import { sourceToOutputTime } from '@/lib/subtitles'
import {
  AnalyzeResponseSchema,
  ClipCandidateSchema,
  checkContext,
  checkRateLimit,
  clamp10,
  clampClipTimes,
  dedupeAndRank,
  determineRecommendation,
  extractJsonObject,
  recalcTotal,
  rateLimitHeaders,
  validateHookAgainstTranscript,
  type ClipScores,
  type Word as TWord,
} from '@/lib/validation'
import type { z } from 'zod'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const PROMPT_VERSION = 'analyze-v3-grounded'
const ANALYSIS_VERSION = '2026.02-transcript-grounded'

interface WordInput { word: string; start: number; end: number }

interface AnalyzeBody {
  projectId?: string
  url?: string
  title: string
  author?: string | null
  duration: number // REQUIRED, REAL (or user-provided) seconds — no defaults
  durationSource?: string
  platform?: string
  style?: string
  targetDuration?: number
  clipCount?: number
  language?: string
  transcript?: string
  words?: WordInput[]
  transcriptSource?: string
  save?: boolean
}

const DEFAULT_PLATFORM = 'shorts'
const DEFAULT_STYLE = 'podcast'

const LANGUAGE_MAP: Record<string, { name: string; code: string }> = {
  auto: { name: 'the video original language', code: '' },
  en: { name: 'English', code: 'en' },
  id: { name: 'Bahasa Indonesia', code: 'id' },
  es: { name: 'Spanish', code: 'es' },
  pt: { name: 'Portuguese', code: 'pt' },
  fr: { name: 'French', code: 'fr' },
  de: { name: 'German', code: 'de' },
  it: { name: 'Italian', code: 'it' },
  nl: { name: 'Dutch', code: 'nl' },
  ru: { name: 'Russian', code: 'ru' },
  ja: { name: 'Japanese', code: 'ja' },
  ko: { name: 'Korean', code: 'ko' },
  zh: { name: 'Chinese', code: 'zh' },
  ar: { name: 'Arabic', code: 'ar' },
  hi: { name: 'Hindi', code: 'hi' },
  th: { name: 'Thai', code: 'th' },
  vi: { name: 'Vietnamese', code: 'vi' },
  ms: { name: 'Malay', code: 'ms' },
}

const PLATFORM_TARGET: Record<string, [number, number]> = {
  shorts: [25, 60],
  reels: [15, 60],
  tiktok: [15, 60],
  custom: [30, 180],
}

function buildSystemPrompt(
  platform: string,
  style: string,
  clipCount: number,
  targetDuration: number,
  language: string,
  hasTranscript: boolean,
  minLen: number,
  maxLen: number,
): string {
  const stylePreset = STYLE_PRESETS.find((s) => s.id === style)
  const styleDesc = stylePreset ? `${stylePreset.label}: ${stylePreset.desc}` : style
  const lang = LANGUAGE_MAP[language] ?? LANGUAGE_MAP.auto
  const langInstruction =
    language === 'auto'
      ? `All text output (titles, generated hooks, reasons, analysis) MUST be in the SAME language as the transcript/source video.`
      : `All text output (titles, generated hooks, reasons, analysis) MUST be written in ${lang.name}. The "spoken_hook" field must still be copied verbatim from the transcript (do not translate it).`

  return `You are ClipForge AI, an expert short-form video editor and content strategist. Your job is to identify the strongest short-form clip candidates from a long-form video for repurposing into ${platform}.

You think like a professional human editor. You find the strongest narrative structure: HOOK → CONTEXT → DEVELOPMENT → PAYOFF. A clip must feel like a complete mini-story or complete idea.

Editing style: ${styleDesc}

TRANSCRIPT GROUNDING RULES (ABSOLUTE — HIGHEST PRIORITY):
1. ONLY select clips that are supported by the supplied transcript. Every candidate's [start, end] window MUST correspond to the actual content spoken in the transcript at that time.
2. "spoken_hook" MUST be copied WORD-FOR-WORD from the transcript, taken from inside the candidate's own time window.
3. NEVER invent, paraphrase-as-quote, or fabricate spoken dialogue. An empty spoken_hook is better than a hallucinated one.
4. NEVER fabricate a timestamp. Timestamps must be plausible for the transcript content you are quoting (transcript positions are provided with timestamps when available).
5. If there is insufficient evidence in the transcript for a strong candidate, REJECT the candidate (do not return filler clips). Returning FEWER than ${clipCount} candidates is acceptable when evidence is insufficient; quality beats quantity.

STAGE 1 — CONTENT ANALYSIS:
Understand the main topic, main argument, important claims, emotional peaks, interesting stories, controversial statements, surprising statements, funny moments, strong opinions, useful insights, potential hooks, and potential payoffs — ALL from the transcript.

STAGE 2 — CLIP SELECTION:
Generate UP TO ${clipCount + 4} candidate clips (the server will validate, deduplicate, and keep only the best ${clipCount}). Each candidate must contain enough context to stand alone. For every candidate provide these scores, each 0-10 with ONE decimal:
- hook (first-3-second pull)
- curiosity
- emotion
- payoff
- standalone (can it be understood alone?)
- shareability
- context_safety (does it avoid misleading the speaker?)
Do NOT compute "total" — the server recalculates it with the documented weights. Do NOT set recommendation — the server decides POST/SKIP.

LANGUAGE REQUIREMENT:
${langInstruction}

RULES:
- Output STRICT JSON only. No markdown, no commentary.
- JSON shape: { "analysis": { "main_topic": "...", "audience": "...", "content_type": "...", "overall_summary": "1-2 sentences" }, "candidates": [ ... ] }
- Each candidate: { "id": "clip_01", "start": <seconds>, "end": <seconds>, "title": "<click-worthy caption under 70 chars>", "spoken_hook": "<verbatim transcript quote from inside this window>", "scores": { "hook": 0, "curiosity": 0, "emotion": 0, "payoff": 0, "standalone": 0, "shareability": 0, "context_safety": 0 }, "reason": "<1 sentence why selected>", "context_risk": <bool>, "tags": ["..."] }
- Candidates must be NON-overlapping, ordered by start.
- Each clip length between ${minLen} and ${maxLen} seconds, close to ${targetDuration}s when possible.
- start >= 0, end > start.${hasTranscript ? '' : '\n- NOTE: no transcript is available for this video. Base candidates ONLY on the title/metadata, set "spoken_hook" to "" for every candidate, and set "context_risk": true on every candidate.'}
Return ONLY the JSON object.`
}

export async function POST(req: NextRequest) {
  // ---------- rate limit + session ----------
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`analyze:${ip}`, 10, 60_000)
  const rlHeaders = rateLimitHeaders(rl, 10)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait a moment before trying again.' },
      { status: 429, headers: { ...rlHeaders, 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  try {
    const ownerId = await getOrCreateSessionId()
    const body = (await req.json()) as AnalyzeBody

    // ---------- input validation (Phase 3) ----------
    const title = (body.title ?? '').trim()
    if (!title) return NextResponse.json({ error: 'Title is required' }, { status: 400, headers: rlHeaders })

    const duration = Number(body.duration)
    if (!isFinite(duration) || duration <= 0) {
      // P1 fix: never fall back to a fake default like 720 — fail explicitly
      return NextResponse.json(
        { error: 'Real video duration is required. Fetch metadata first or enter the duration manually — ClipForge does not guess durations.' },
        { status: 400, headers: rlHeaders },
      )
    }

    const platform = body.platform && PLATFORM_TARGET[body.platform] ? body.platform : DEFAULT_PLATFORM
    const style = body.style ?? DEFAULT_STYLE
    const clipCount = Math.max(3, Math.min(10, body.clipCount ?? 6))
    const language = body.language ?? 'auto'
    const [minLen, maxLen] = PLATFORM_TARGET[platform]
    const targetDuration =
      body.targetDuration && body.targetDuration > 0
        ? Math.max(minLen, Math.min(maxLen, body.targetDuration))
        : Math.round((minLen + maxLen) / 2)

    // ---------- ownership check when persisting ----------
    let project: { id: string; transcript: string | null; transcriptWords: string | null; transcriptSource: string } | null = null
    if (body.projectId) {
      const p = await db.project.findUnique({ where: { id: body.projectId } })
      if (!p || p.ownerId !== ownerId) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404, headers: rlHeaders })
      }
      project = p
    }

    // words: body wins, then project record
    let words: TWord[] = Array.isArray(body.words)
      ? body.words.filter((w) => typeof w?.word === 'string' && isFinite(w?.start) && isFinite(w?.end)).map((w) => ({ word: w.word, start: Number(w.start), end: Number(w.end) }))
      : []
    if (words.length === 0 && project?.transcriptWords) {
      try {
        const parsed = JSON.parse(project.transcriptWords) as TWord[]
        if (Array.isArray(parsed)) words = parsed
      } catch { /* corrupted JSON → treat as absent */ }
    }
    // transcript: body wins, then project record, then synthesized from word timestamps
    const transcript = ((body.transcript ?? '').trim() || project?.transcript?.trim() || (words.length > 0 ? words.map((w) => w.word).join(' ') : '')) as string
    const transcriptSource = body.transcriptSource ?? project?.transcriptSource ?? (transcript ? 'manual' : 'none')
    const hasTranscript = transcript.length > 0

    // ---------- LLM call ----------
    const zai = await ZAI.create()

    // transcript section with timestamps for grounding
    let transcriptSection: string
    if (hasTranscript) {
      const wordsSample = words.length > 0
        ? `\nWORD-LEVEL TIMESTAMPS (first ${Math.min(400, words.length)} words — use these to place candidate windows):\n` +
          words.slice(0, 400).map((w) => `[${w.start.toFixed(1)}-${w.end.toFixed(1)}] ${w.word}`).join(' ')
        : ''
      transcriptSection = `\n\nVIDEO TRANSCRIPT (REAL SOURCE CONTENT — every decision MUST come from this):\n"""\n${transcript.slice(0, 24_000)}\n"""${wordsSample}\n\nCRITICAL: spoken_hook MUST be a word-for-word quote from this transcript inside the candidate window. Timestamps must match transcript positions. If evidence is insufficient for ${clipCount} strong clips, return fewer.`
    } else {
      transcriptSection = `\n\nNOTE: NO transcript is available. You have NO access to the actual content. Set "spoken_hook" to "" for every candidate and set "context_risk": true on every candidate. Do NOT fabricate quotes. Do NOT pretend to know the content.`
    }

    const userPrompt = `Analyze this video and propose up to ${clipCount + 4} highlight clip candidates for ${platform} in "${style}" style.

Video title: "${title}"
Channel: ${body.author ?? 'Unknown'}
Duration: ${duration} seconds (~${Math.round(duration / 60)} min ${Math.round(duration % 60)}s)
Target clip duration: ${targetDuration}s
${transcriptSection}

Return the JSON object now.`

    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: buildSystemPrompt(platform, style, clipCount, targetDuration, language, hasTranscript, minLen, maxLen) },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: 'disabled' },
    })

    const raw = completion.choices[0]?.message?.content ?? ''

    // ---------- Phase 4: extraction (balanced-brace) + ZOD validation ----------
    let parsed = extractJsonObject(raw)
    let zodResult = AnalyzeResponseSchema.safeParse(parsed)

    // one repair attempt when the model returned invalid structure
    if (!zodResult.success) {
      const issues = zodResult.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      const repair = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: 'You return STRICT JSON only. No markdown, no commentary.' },
          { role: 'user', content: `The following AI response failed schema validation.\nIssues: ${issues}\n\nReturn the CORRECTED JSON object with the same required shape (analysis + candidates array; each candidate needs start/end (numbers), title (string), spoken_hook (string), scores (object with hook, curiosity, emotion, payoff, standalone, shareability, context_safety numbers), reason (string), context_risk (boolean)).\n\nOriginal response:\n"""\n${raw.slice(0, 20_000)}\n"""\n\nReturn ONLY the corrected JSON.` },
        ],
        thinking: { type: 'disabled' },
      })
      const rawRepair = repair.choices[0]?.message?.content ?? ''
      parsed = extractJsonObject(rawRepair)
      zodResult = AnalyzeResponseSchema.safeParse(parsed)
      if (!zodResult.success) {
        return NextResponse.json(
          { error: 'AI response failed schema validation after a repair attempt.', issues: zodResult.error.issues.slice(0, 4).map((i) => i.message) },
          { status: 502, headers: rlHeaders },
        )
      }
    }

    const validated = zodResult.data

    // ---------- Phases 5-8: server-side pipeline ----------
    const processed = validated.candidates.map((c, idx) => processCandidate(c, idx, {
      duration, minLen, maxLen, hasTranscript, transcript, words,
    }))

    // Phase 8: server-side dedupe + rank + enforce count
    const finalClips = dedupeAndRank(processed, clipCount)

    if (finalClips.length === 0) {
      return NextResponse.json(
        { error: hasTranscript ? 'No valid clips could be validated against the transcript. Try a different target duration or platform.' : 'No valid clips generated after validation.' },
        { status: 502, headers: rlHeaders },
      )
    }

    // ---------- persist (transactional, Phase 12) ----------
    let analysisMeta: Record<string, unknown> | null = null
    if ((body.save ?? true) && project) {
      const model = (completion as unknown as { model?: string }).model ?? 'unknown'
      const meta = {
        model,
        provider: 'z-ai',
        promptVersion: PROMPT_VERSION,
        analysisVersion: ANALYSIS_VERSION,
        analyzedAt: new Date().toISOString(),
        transcriptSource,
        durationSource: body.durationSource ?? 'unknown',
      }
      analysisMeta = meta
      const pid = project.id
      await db.$transaction(async (tx) => {
        await tx.clip.deleteMany({ where: { projectId: pid } })
        for (let i = 0; i < finalClips.length; i++) {
          const c = finalClips[i]
          await tx.clip.create({
            data: {
              projectId: pid,
              title: c.title,
              summary: validated.analysis?.overall_summary?.slice(0, 500) ?? null,
              startTime: c.start,
              endTime: c.end,
              score: c.scores.total,
              tags: JSON.stringify(c.tags),
              hookText: c.spokenHook || null,
              spokenHook: c.spokenHook || null,
              hookVerified: c.hookVerified,
              platform,
              status: 'suggested',
              order: i,
              style,
              targetDuration: Math.round(targetDuration),
              scores: JSON.stringify(c.scores),
              contextRisk: c.contextRisk,
              contextStatus: c.contextStatus,
              recommendation: c.recommendation,
              reason: c.reason,
              clipTranscript: c.transcriptExcerpt || null,
              clipWords: c.clipWords.length > 0 ? JSON.stringify(c.clipWords) : null,
            },
          })
        }
        await tx.project.update({
          where: { id: pid },
          data: {
            status: 'analyzed',
            clipCount: finalClips.length,
            analysisMeta: JSON.stringify(meta),
            ...(hasTranscript && !project!.transcript ? { transcript } : {}),
            ...(words.length > 0 && !project!.transcriptWords ? { transcriptWords: JSON.stringify(words) } : {}),
            ...(transcriptSource !== 'none' ? { transcriptSource } : {}),
          },
        })
      })
    }

    return NextResponse.json({
      candidates: finalClips,
      platform,
      style,
      targetDuration,
      language,
      contentSummary: String(validated.analysis?.overall_summary ?? '').slice(0, 300),
      analysis: validated.analysis
        ? {
            main_topic: String(validated.analysis.main_topic ?? '').slice(0, 200),
            audience: String(validated.analysis.audience ?? '').slice(0, 200),
            content_type: String(validated.analysis.content_type ?? '').slice(0, 120),
            overall_summary: String(validated.analysis.overall_summary ?? '').slice(0, 300),
          }
        : undefined,
      transcriptSource,
      transcriptGrounded: hasTranscript,
      analysisMeta,
      meta: {
        serverScored: true,
        requestedCount: clipCount,
        returnedCount: finalClips.length,
        promptVersion: PROMPT_VERSION,
        analysisVersion: ANALYSIS_VERSION,
      },
    }, { headers: rlHeaders })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to analyze video'
    console.error('Analyze error:', e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Candidate processing: clamps → word alignment → server scoring → context
// ---------------------------------------------------------------------------

interface ProcessCtx {
  duration: number
  minLen: number
  maxLen: number
  hasTranscript: boolean
  transcript: string
  words: TWord[]
}

type AICandidate = z.infer<typeof ClipCandidateSchema>

interface ProcessedClip {
  id: string
  start: number
  end: number
  duration: number
  title: string
  spokenHook: string
  hookVerified: boolean
  scores: ClipScores
  reason: string
  contextRisk: boolean
  contextStatus: string
  recommendation: 'POST' | 'SKIP'
  tags: string[]
  transcriptExcerpt: string
  clipWords: TWord[]
}

function processCandidate(c: AICandidate, idx: number, ctx: ProcessCtx): ProcessedClip {
  const { duration, minLen, maxLen, hasTranscript, transcript, words } = ctx

  // Phase 6: hard timestamp validation
  let { start, end } = clampClipTimes(Number(c.start) || 0, Number(c.end) || 0, duration, minLen, maxLen)

  // word-timestamp alignment: snap to actual word boundaries when available
  const sortedWords = [...words].sort((a, b) => a.start - b.start)
  if (sortedWords.length > 0) {
    const firstIn = sortedWords.find((w) => w.end > start - 0.5)
    const lastIn = [...sortedWords].reverse().find((w) => w.start < end + 0.5)
    if (firstIn && Math.abs(firstIn.start - start) <= 2.5) start = Math.round(firstIn.start * 10) / 10
    if (lastIn && Math.abs(lastIn.end - end) <= 2.5) end = Math.round(lastIn.end * 10) / 10
    if (end <= start) ({ start, end } = clampClipTimes(start, end, duration, minLen, maxLen))
  }

  // Phase 7: transcript-context validation (PASS / EXTEND / REJECT)
  let contextStatus = 'UNKNOWN'
  let contextRisk = Boolean(c.context_risk)
  if (sortedWords.length > 0) {
    const cc = checkContext({ clipStart: start, clipEnd: end, minLen, maxLen, words: sortedWords, duration })
    if (cc.status !== 'REJECT') {
      start = cc.start
      end = cc.end
      const recheck = clampClipTimes(start, end, duration, Math.min(minLen, 10), maxLen)
      start = recheck.start
      end = recheck.end
    } else if (end - start >= Math.min(minLen, 10)) {
      // keep the un-extended window but flag risk
      contextRisk = true
    }
    contextStatus = cc.status
    if (cc.contextRisk) contextRisk = true
  }

  // spoken hook: verbatim-from-transcript requirement
  const hookRaw = String(c.spoken_hook ?? c.hook ?? '').trim()
  let spokenHook = hookRaw.slice(0, 300)
  let hookVerified = false
  if (hasTranscript && spokenHook) {
    const v = validateHookAgainstTranscript(spokenHook, transcript)
    hookVerified = v.match && v.confidence >= 0.7
    if (!hookVerified) spokenHook = '' // never present a fabricated quote as verified
  } else if (!hasTranscript) {
    hookVerified = false
    if (spokenHook) {
      // model fabricated a quote with no transcript — drop it
      spokenHook = ''
    }
  }

  // transcript excerpt + clip-local words (grounded data for plan/export)
  const clipWords = sortedWords.filter((w) => w.end > start && w.start < end)
  const transcriptExcerpt = clipWords.length > 0
    ? clipWords.map((w) => w.word).join(' ')
    : hasTranscript
      ? excerptFromText(transcript, start, end, duration)
      : ''

  // Phase 5: server-side scoring — the model's total/recommendation are ignored
  const rawScores = {
    hook: clamp10(c.scores?.hook),
    curiosity: clamp10(c.scores?.curiosity),
    emotion: clamp10(c.scores?.emotion),
    payoff: clamp10(c.scores?.payoff),
    standalone: clamp10(c.scores?.standalone),
    shareability: clamp10(c.scores?.shareability),
    context_safety: clamp10(c.scores?.context_safety),
  }
  // unverified hook caps the hook dimension and context safety (server-side penalty)
  if (hasTranscript && !hookVerified) {
    rawScores.hook = Math.min(rawScores.hook, 4)
    rawScores.context_safety = Math.min(rawScores.context_safety, 5)
  }
  const total = recalcTotal(rawScores)
  const scores: ClipScores = { ...rawScores, total }
  const recommendation = determineRecommendation(total, rawScores.context_safety)

  return {
    id: String(c.id ?? `clip_${String(idx + 1).padStart(2, '0')}`),
    start,
    end,
    duration: Math.round((end - start) * 10) / 10,
    title: String(c.title ?? `Clip ${idx + 1}`).slice(0, 140),
    spokenHook,
    hookVerified,
    scores,
    reason: String(c.reason ?? '').slice(0, 300),
    contextRisk,
    contextStatus,
    recommendation,
    tags: Array.isArray(c.tags) ? c.tags.slice(0, 6).map((t) => String(t).slice(0, 30)) : [],
    transcriptExcerpt: transcriptExcerpt.slice(0, 4000),
    clipWords: clipWords.slice(0, 2000),
  }
}

/** Fallback excerpt from plain text transcript (no word timing): proportional slice. */
function excerptFromText(transcript: string, start: number, end: number, duration: number): string {
  const dur = Math.max(1, duration)
  const from = Math.floor((start / dur) * transcript.length)
  const to = Math.ceil((end / dur) * transcript.length)
  return transcript.slice(Math.max(0, from - 200), Math.min(transcript.length, to + 200)).replace(/\s+/g, ' ').trim()
}

// output-time helper re-export used by tests
export const __testHelpers = { sourceToOutputTime }

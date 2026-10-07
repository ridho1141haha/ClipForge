import { z } from 'zod'

// ===========================================================================
// ClipForge — validation, server-side scoring, context validation, dedupe
// ===========================================================================

/** Word-level timestamp (shared shape across analyze/plan/export). */
export interface Word {
  word: string
  start: number
  end: number
}

// ---- Score validation + server-side recalculation (Phase 5) ----

export const SCORE_WEIGHTS = {
  hook: 0.2,
  curiosity: 0.15,
  payoff: 0.2,
  standalone: 0.15,
  shareability: 0.15,
  emotion: 0.1,
  context_safety: 0.05,
} as const

export interface ClipScores {
  hook: number
  curiosity: number
  emotion: number
  payoff: number
  standalone: number
  shareability: number
  context_safety: number
  total: number // 0-100
}

/**
 * Server-side weighted total on the documented 0-100 scale:
 * total = (hook*0.20 + curiosity*0.15 + payoff*0.20 + standalone*0.15
 *          + shareability*0.15 + emotion*0.10 + context_safety*0.05) * 10
 * The LLM's own "total" is NEVER trusted.
 */
export function recalcTotal(scores: Omit<ClipScores, 'total'>): number {
  const weighted =
    scores.hook * SCORE_WEIGHTS.hook +
    scores.curiosity * SCORE_WEIGHTS.curiosity +
    scores.payoff * SCORE_WEIGHTS.payoff +
    scores.standalone * SCORE_WEIGHTS.standalone +
    scores.shareability * SCORE_WEIGHTS.shareability +
    scores.emotion * SCORE_WEIGHTS.emotion +
    scores.context_safety * SCORE_WEIGHTS.context_safety
  // weighted sum ∈ [0,10] → ×10 → [0,100]
  return Math.round(weighted * 10 * 10) / 10
}

/** Server-side POST/SKIP — never trust the LLM's recommendation. */
export function determineRecommendation(total: number, contextSafety: number): 'POST' | 'SKIP' {
  if (total >= 60 && contextSafety >= 7) return 'POST'
  return 'SKIP'
}

export function clamp10(v: unknown): number {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10))
}

// ---- Timestamp validation (Phase 6) ----

export function clampClipTimes(
  start: number,
  end: number,
  duration: number,
  minLen: number,
  maxLen: number,
): { start: number; end: number } {
  const dur = Math.max(1, duration)
  let s = Math.max(0, Math.min(dur - Math.min(minLen, dur), Number(start) || 0))
  let e = Math.min(dur, Math.max(s + Math.min(minLen, dur), Number(end) || s + minLen))
  if (e <= s) e = Math.min(dur, s + Math.min(maxLen, 30))
  if (e - s > maxLen) e = s + maxLen
  if (e - s < minLen) {
    e = s + minLen
    if (e > dur) {
      e = dur
      s = Math.max(0, e - minLen)
    }
  }
  if (e > dur) e = dur
  if (s < 0) s = 0
  if (s >= e) s = Math.max(0, e - 1)
  return { start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10 }
}

// ---- Zod schemas for AI responses (Phase 4) ----

export const ClipScoreSchema = z.object({
  hook: z.number(),
  curiosity: z.number(),
  emotion: z.number(),
  payoff: z.number(),
  standalone: z.number(),
  shareability: z.number(),
  context_safety: z.number(),
  total: z.number().optional(), // ignored — recalculated server-side
})

export const ClipCandidateSchema = z.object({
  id: z.string().optional(),
  start: z.number(),
  end: z.number(),
  duration: z.number().optional(),
  title: z.string(),
  spoken_hook: z.string().optional(), // preferred field name
  hook: z.string().optional(), // legacy alias
  scores: ClipScoreSchema,
  reason: z.string().optional(),
  context_risk: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
})

export const AnalyzeResponseSchema = z.object({
  analysis: z
    .object({
      main_topic: z.string().default(''),
      audience: z.string().default(''),
      content_type: z.string().default(''),
      overall_summary: z.string().default(''),
    })
    .optional(),
  candidates: z.array(ClipCandidateSchema).min(1),
  estimatedDuration: z.number().optional(),
})

export const EditPlanSchema = z.object({
  project: z.object({
    title: z.string(),
    style: z.string(),
    platform: z.string(),
    target_duration: z.number(),
    aspect_ratio: z.string(),
  }),
  analysis: z
    .object({
      main_topic: z.string(),
      audience: z.string(),
      content_type: z.string(),
      overall_summary: z.string(),
    })
    .partial()
    .optional(),
  selected_clip: z.object({
    id: z.string(),
    start: z.number(),
    end: z.number(),
    duration: z.number(),
    title: z.string(),
    generated_hook: z.string().optional(),
    segments: z
      .array(
        z.object({
          type: z.string(),
          start: z.number(),
          end: z.number(),
          purpose: z.string(),
          subtitle: z.string().optional(),
          emphasis_words: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    cuts: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          reason: z.string().optional(),
        }),
      )
      .default([]),
    camera: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          scale_start: z.number(),
          scale_end: z.number(),
          reason: z.string().optional(),
        }),
      )
      .default([]),
    visuals: z
      .array(
        z.object({
          type: z.string(),
          start: z.number(),
          end: z.number(),
          purpose: z.string(),
          prompt: z.string(),
          aspect_ratio: z.string(),
          transition: z.string().optional(),
        }),
      )
      .default([]),
    animations: z
      .array(
        z.object({
          type: z.string(),
          start: z.number(),
          end: z.number(),
          text: z.string().optional(),
          animation: z.string(),
        }),
      )
      .default([]),
    sound_effects: z
      .array(
        z.object({
          type: z.string(),
          start: z.number(),
          duration: z.number(),
          intensity: z.number(),
        }),
      )
      .default([]),
    music: z
      .object({
        recommended: z.boolean(),
        style: z.string(),
        intensity: z.number(),
        ducking_percent: z.number(),
      })
      .optional(),
    subtitles: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          text: z.string(),
          emphasis_words: z.array(z.string()).default([]),
          emphasis_type: z.string().optional(),
          // real word timestamps inside the block (SOURCE time) — optional;
          // only trustworthy when the plan route verified the block text is
          // composed of exactly these words
          word_timings: z
            .array(z.object({ word: z.string(), start: z.number(), end: z.number() }))
            .optional(),
        }),
      )
      .default([]),
  }),
})

// ---- JSON extraction (extraction ONLY — validation is Zod's job) ----

export function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null
  // 1) direct fenced block ```json ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates: string[] = []
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  // 2) first balanced object (brace counting, string-aware)
  const start = raw.indexOf('{')
  if (start !== -1) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = !inStr
        continue
      }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(raw.slice(start, i + 1))
          break
        }
      }
    }
  }
  if (candidates.length === 0) return null
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      try {
        return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')) // trailing commas
      } catch {
        continue
      }
    }
  }
  return null
}

// ---- Transcript-grounded hook validation ----

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"'`'""\u200b]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Order-preserving subsequence test: every hook word must appear in the
 * transcript stream in the same relative order (gaps allowed).
 */
function isOrderedSubsequence(hookWords: string[], transcriptWords: string[]): boolean {
  let ti = 0
  for (const hw of hookWords) {
    while (ti < transcriptWords.length && transcriptWords[ti] !== hw) ti++
    if (ti >= transcriptWords.length) return false
    ti++ // consume
  }
  return true
}

/**
 * Confidence threshold at which a hook may be marked VERIFIED.
 * A bare 3-gram appearing anywhere is deliberately NOT enough any more.
 */
export const HOOK_VERIFY_THRESHOLD = 0.8

/**
 * Verify a spoken hook against a transcript — STRICT tiers:
 *  1.0  exact normalized phrase contained in the transcript
 *  0.95 contiguous ≥6-word run of the hook found verbatim
 *  0.90 contiguous 5-word run
 *  0.85 contiguous 4-word run AND ≥80% of hook tokens present
 *  0.80 contiguous 3-word run AND ≥90% coverage, OR ≥95% coverage with all
 *       words present in order (reconstruction from the actual word stream)
 *  Anything weaker does NOT match (confidence reported for diagnostics only).
 * Empty transcript = NOT verified, ever.
 */
export function validateHookAgainstTranscript(
  hook: string,
  transcript: string | null | undefined,
): { match: boolean; confidence: number } {
  if (!transcript || !transcript.trim()) return { match: false, confidence: 0 }
  const hookNorm = normalizeText(hook)
  if (!hookNorm) return { match: false, confidence: 0 }
  const transcriptNorm = normalizeText(transcript)
  const hookWords = hookNorm.split(' ').filter(Boolean)
  if (hookWords.length === 0) return { match: false, confidence: 0 }
  if (transcriptNorm.includes(hookNorm)) return { match: true, confidence: 1 }

  // longest contiguous run of the hook's words found verbatim in the transcript
  let bestRun = 0
  for (let len = Math.min(hookWords.length, 12); len >= 3; len--) {
    let found = false
    for (let i = 0; i + len <= hookWords.length; i++) {
      if (transcriptNorm.includes(hookWords.slice(i, i + len).join(' '))) {
        found = true
        break
      }
    }
    if (found) {
      bestRun = len
      break
    }
  }

  // token coverage: fraction of hook words present anywhere in the transcript
  const tWords = new Set(transcriptNorm.split(' ').filter(Boolean))
  const covered = hookWords.filter((w) => tWords.has(w)).length
  const coverage = covered / hookWords.length

  if (bestRun >= 6) return { match: true, confidence: 0.95 }
  if (bestRun >= 5) return { match: true, confidence: 0.9 }
  if (bestRun >= 4 && coverage >= 0.8) return { match: true, confidence: 0.85 }
  if (bestRun >= 3 && coverage >= 0.9) return { match: true, confidence: 0.8 }
  if (
    hookWords.length >= 5 &&
    coverage >= 0.95 &&
    isOrderedSubsequence(hookWords, transcriptNorm.split(' ').filter(Boolean))
  ) {
    return { match: true, confidence: 0.8 }
  }
  // diagnostic-only confidence (never reaches HOOK_VERIFY_THRESHOLD)
  return { match: false, confidence: bestRun >= 3 ? 0.5 : coverage >= 0.6 ? 0.4 : 0 }
}

// ---- Context validation (Phase 7) ----

export type ContextStatus = 'PASS' | 'EXTEND' | 'REJECT' | 'UNKNOWN'

const DEPENDENT_OPENERS = [
  'and', 'but', 'so', 'because', 'that', "that's", 'this', 'these', 'those',
  'which', 'then', 'also', 'even', 'just', 'like i said', 'as i said',
  'anyway', 'however', 'therefore', 'meanwhile', 'jadi', 'tapi', 'karena',
  'makanya', 'terus', 'itu', 'nah', 'dan', 'jadi begini',
]

export interface ContextCheckInput {
  clipStart: number
  clipEnd: number
  minLen: number
  maxLen: number
  words: { word: string; start: number; end: number }[]
  duration: number
}

export interface ContextCheckResult {
  status: ContextStatus
  start: number // possibly extended start
  end: number // possibly extended end
  contextRisk: boolean
  reason: string
}

/**
 * Transcript-context validation:
 *  - detects clips that begin mid-thought (dependent opener) and extends them
 *    backwards to the previous natural boundary (pause > 0.6s) when possible;
 *  - detects clips that end mid-sentence and extends forward;
 *  - REJECTs when extension is impossible or evidence is contradictory.
 */
export function checkContext(input: ContextCheckInput): ContextCheckResult {
  const { clipStart, clipEnd, minLen, maxLen, words, duration } = input
  const sorted = [...words].sort((a, b) => a.start - b.start)
  const inside = sorted.filter((w) => w.end > clipStart && w.start < clipEnd)
  if (inside.length === 0) {
    return { status: 'UNKNOWN', start: clipStart, end: clipEnd, contextRisk: true, reason: 'No transcript words inside clip window' }
  }
  let start = clipStart
  let end = clipEnd
  let status: ContextStatus = 'PASS'
  let risk = false
  let reason = 'Clip boundaries align with speech'

  // --- leading boundary ---
  const firstWord = inside[0]
  const idxFirst = sorted.indexOf(firstWord)
  const prevWord = idxFirst > 0 ? sorted[idxFirst - 1] : null
  const startsClean = clipStart - (prevWord ? prevWord.end : -Infinity) >= 0.5 || idxFirst === 0
  const opener = normalizeText(firstWord.word)
  const dependentOpen = DEPENDENT_OPENERS.includes(opener)

  if (dependentOpen || (!startsClean && clipStart - firstWord.start > 0.4)) {
    // try to extend backwards to previous pause >= 0.6s (or video start)
    let newStart = clipStart
    for (let i = idxFirst; i > 0; i--) {
      const gap = sorted[i].start - sorted[i - 1].end
      if (gap >= 0.6) {
        newStart = Math.max(0, sorted[i].start - 0.25)
        break
      }
      newStart = Math.max(0, sorted[i - 1].start - 0.1)
      if (clipStart - newStart > maxLen * 0.6) break // don't over-extend
    }
    if (clipStart - newStart >= 0.8 && end - newStart <= maxLen) {
      start = Math.round(newStart * 10) / 10
      status = 'EXTEND'
      reason = 'Extended start to include preceding context (clip began mid-thought)'
    } else if (clipStart - newStart >= 0.8) {
      risk = true
      status = 'EXTEND'
      reason = 'Needs preceding context but extension would exceed max length'
    } else if (dependentOpen) {
      risk = true
      reason = `Clip opens with dependent word "${firstWord.word}" — may rely on missing context`
    }
  }

  // --- trailing boundary ---
  const lastWord = inside[inside.length - 1]
  const idxLast = sorted.indexOf(lastWord)
  const nextWord = idxLast < sorted.length - 1 ? sorted[idxLast + 1] : null
  const endsClean = nextWord ? nextWord.start - lastWord.end >= 0.5 : true
  // punctuation must be tested on the RAW word — normalizeText strips it, and
  // testing a stripped string for punctuation is always false (real bug)
  const endsMidPunct = /[.!?…]["')\]]?$/.test(lastWord.word.trim())
  const midSentence = !endsClean && !endsMidPunct
  if (midSentence && nextWord) {
    let newEnd = end
    for (let i = idxLast + 1; i < sorted.length; i++) {
      newEnd = Math.min(duration, sorted[i].end + 0.3)
      const gapAfter = i < sorted.length - 1 ? sorted[i + 1].start - sorted[i].end : Infinity
      const punct = /[.!?…]$/.test(normalizeText(sorted[i].word))
      if (punct || gapAfter >= 0.6) break
      if (newEnd - start > maxLen) break
    }
    if (newEnd - end >= 0.4 && newEnd - start <= maxLen && newEnd <= duration) {
      end = Math.round(newEnd * 10) / 10
      if (status !== 'EXTEND') status = 'EXTEND'
      reason = reason.startsWith('Extended start') ? 'Extended start & end for complete context' : 'Extended end to complete the sentence'
    } else {
      risk = true
      reason = (reason ? reason + '; ' : '') + 'Clip ends mid-sentence and cannot be extended within limits'
    }
  }

  if (end - start < minLen) {
    // extension broke the minimum length — clamp back
    return { status: 'REJECT', start: clipStart, end: clipEnd, contextRisk: true, reason: 'Context extension would violate duration constraints' }
  }
  return { status, start, end, contextRisk: risk, reason }
}

// ---- Dedupe + ranking (Phase 8) ----

export interface DedupeClip {
  start: number
  end: number
  scores: ClipScores
  title?: string
  transcriptExcerpt?: string
  hookVerified?: boolean
  contextStatus?: string
}

function jaccard(a: string, b: string, minWordLen = 0): number {
  const sa = new Set(normalizeText(a).split(' ').filter((w) => w.length > minWordLen))
  const sb = new Set(normalizeText(b).split(' ').filter((w) => w.length > minWordLen))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  return jaccard(na, nb, 0) // titles: keep ALL words (short tokens matter)
}

/**
 * Server-side dedupe + rank:
 *  1. sort by server-calculated total desc
 *  2. drop exact/overlapping candidates (>overlapThreshold of the shorter clip)
 *  3. drop semantically equivalent candidates (title or excerpt similarity)
 *  4. keep top `requestedCount`, return sorted by start
 */
export function dedupeAndRank<T extends DedupeClip>(
  clips: T[],
  requestedCount: number,
  overlapThreshold = 0.5,
): T[] {
  const sorted = [...clips].sort((a, b) => b.scores.total - a.scores.total)
  const kept: T[] = []
  for (const clip of sorted) {
    if (kept.length >= requestedCount) break
    const hasOverlap = kept.some((k) => {
      const overlap = Math.min(clip.end, k.end) - Math.max(clip.start, k.start)
      const minLen = Math.min(clip.end - clip.start, k.end - k.start)
      return overlap > minLen * overlapThreshold
    })
    if (hasOverlap) continue
    const isDupe = kept.some((k) => {
      const tSim = clip.title && k.title ? titleSimilarity(clip.title, k.title) : 0
      const eSim = clip.transcriptExcerpt && k.transcriptExcerpt ? jaccard(clip.transcriptExcerpt, k.transcriptExcerpt) : 0
      return tSim > 0.8 || eSim > 0.85
    })
    if (isDupe) continue
    kept.push(clip)
  }
  return kept.sort((a, b) => a.start - b.start)
}

// ---- Rate limiting (Phase 11) ----
// NOTE: in-memory — appropriate for single-instance/dev. For multi-instance
// production use a shared store (Redis / Postgres). See README "Production notes".

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

// periodic cleanup to avoid unbounded growth
let lastSweep = 0
function sweep(now: number) {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [k, v] of rateLimitStore) if (v.resetAt < now) rateLimitStore.delete(k)
}

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()
  sweep(now)
  const entry = rateLimitStore.get(key)
  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs }
  }
  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }
  entry.count++
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt }
}

export function rateLimitHeaders(rl: { remaining: number; resetAt: number }, max: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(max),
    'X-RateLimit-Remaining': String(Math.max(0, rl.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
  }
}

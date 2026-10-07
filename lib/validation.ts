import { z } from 'zod'

// ---- Score validation + server-side recalculation ----

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
  total: number
}

// Server-side score recalculation — NEVER trust LLM's total
export function recalcTotal(scores: Omit<ClipScores, 'total'>): number {
  const total =
    scores.hook * SCORE_WEIGHTS.hook +
    scores.curiosity * SCORE_WEIGHTS.curiosity +
    scores.payoff * SCORE_WEIGHTS.payoff +
    scores.standalone * SCORE_WEIGHTS.standalone +
    scores.shareability * SCORE_WEIGHTS.shareability +
    scores.emotion * SCORE_WEIGHTS.emotion +
    scores.context_safety * SCORE_WEIGHTS.context_safety
  return Math.round(total * 10) / 10 // 0-100 (since each dim is 0-10, weighted sum is 0-10, ×10 = 0-100)
}

// Server-side POST/SKIP determination — NEVER trust LLM's recommendation
export function determineRecommendation(total: number, contextSafety: number): 'POST' | 'SKIP' {
  if (total >= 60 && contextSafety >= 7) return 'POST'
  return 'SKIP'
}

function clamp10(v: any): number {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10))
}

// ---- Timestamp validation ----

// Fix the P0 bug: end > duration after minLen adjustment
export function clampClipTimes(
  start: number,
  end: number,
  duration: number,
  minLen: number,
  maxLen: number,
): { start: number; end: number } {
  let s = Math.max(0, Math.min(duration - minLen, Number(start) || 0))
  let e = Math.min(duration, Math.max(s + minLen, Number(end) || s + minLen))
  if (e <= s) e = s + Math.min(maxLen, 30)
  // if clip too long, cap end
  if (e - s > maxLen) e = s + maxLen
  // if clip too short, try to extend end first, then move start backward
  if (e - s < minLen) {
    e = s + minLen
    if (e > duration) {
      e = duration
      s = Math.max(0, e - minLen)
    }
  }
  // final safety: never exceed duration
  if (e > duration) e = duration
  if (s < 0) s = 0
  if (s >= e) s = Math.max(0, e - 1)
  return {
    start: Math.round(s * 10) / 10,
    end: Math.round(e * 10) / 10,
  }
}

// ---- Non-overlap validation + clip count enforcement ----

export interface ValidatedClip {
  id: string
  start: number
  end: number
  duration: number
  title: string
  hook: string
  scores: ClipScores
  reason: string
  context_risk: boolean
  recommendation: 'POST' | 'SKIP'
  tags?: string[]
}

// Sort by score desc, remove overlaps, enforce count
export function dedupeAndRank(clips: ValidatedClip[], requestedCount: number, overlapThreshold = 0.5): ValidatedClip[] {
  // sort by total score descending
  const sorted = [...clips].sort((a, b) => b.scores.total - a.scores.total)
  const kept: ValidatedClip[] = []
  for (const clip of sorted) {
    if (kept.length >= requestedCount) break
    // check overlap with already-kept clips
    const hasOverlap = kept.some((k) => {
      const overlap = Math.min(clip.end, k.end) - Math.max(clip.start, k.start)
      const minLen = Math.min(clip.end - clip.start, k.end - k.start)
      return overlap > minLen * overlapThreshold
    })
    if (!hasOverlap) kept.push(clip)
  }
  // sort final by start time
  return kept.sort((a, b) => a.start - b.start)
}

// ---- Zod schemas for AI response validation ----

export const ClipScoreSchema = z.object({
  hook: z.number(),
  curiosity: z.number(),
  emotion: z.number(),
  payoff: z.number(),
  standalone: z.number(),
  shareability: z.number(),
  context_safety: z.number(),
  total: z.number().optional(),
})

export const ClipCandidateSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  duration: z.number().optional(),
  title: z.string(),
  hook: z.string(),
  scores: ClipScoreSchema,
  reason: z.string(),
  context_risk: z.boolean(),
  recommendation: z.string(),
})

export const AnalyzeResponseSchema = z.object({
  analysis: z.object({
    main_topic: z.string(),
    audience: z.string(),
    content_type: z.string(),
    overall_summary: z.string(),
  }),
  candidates: z.array(ClipCandidateSchema),
  estimatedDuration: z.number().optional(),
})

export const EditSegmentSchema = z.object({
  type: z.string(),
  start: z.number(),
  end: z.number(),
  purpose: z.string(),
  subtitle: z.string(),
  emphasis_words: z.array(z.string()),
})

export const EditPlanSchema = z.object({
  project: z.object({
    title: z.string(),
    style: z.string(),
    platform: z.string(),
    target_duration: z.number(),
    aspect_ratio: z.string(),
  }),
  analysis: z.object({
    main_topic: z.string(),
    audience: z.string(),
    content_type: z.string(),
    overall_summary: z.string(),
  }),
  selected_clip: z.object({
    id: z.string(),
    start: z.number(),
    end: z.number(),
    duration: z.number(),
    title: z.string(),
    generated_hook: z.string(),
    segments: z.array(EditSegmentSchema),
    cuts: z.array(z.object({
      start: z.number(),
      end: z.number(),
      reason: z.string(),
    })),
    camera: z.array(z.object({
      start: z.number(),
      end: z.number(),
      scale_start: z.number(),
      scale_end: z.number(),
      reason: z.string(),
    })),
    visuals: z.array(z.object({
      type: z.string(),
      start: z.number(),
      end: z.number(),
      purpose: z.string(),
      prompt: z.string(),
      aspect_ratio: z.string(),
      transition: z.string().optional(),
    })),
    animations: z.array(z.object({
      type: z.string(),
      start: z.number(),
      end: z.number(),
      text: z.string().optional(),
      animation: z.string(),
    })),
    sound_effects: z.array(z.object({
      type: z.string(),
      start: z.number(),
      duration: z.number(),
      intensity: z.number(),
    })),
    music: z.object({
      recommended: z.boolean(),
      style: z.string(),
      intensity: z.number(),
      ducking_percent: z.number(),
    }),
    subtitles: z.array(z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
      emphasis_words: z.array(z.string()),
      emphasis_type: z.string().optional(),
    })),
  }),
})

// ---- Transcript-grounded hook validation ----

// Normalize text for fuzzy matching
export function normalizeText(s: string): string {
  return s.toLowerCase()
    .replace(/[.,!?;:"'"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Check if spoken hook exists in transcript (fuzzy)
export function validateHookAgainstTranscript(hook: string, transcript: string): { match: boolean; confidence: number } {
  if (!transcript || !transcript.trim()) return { match: true, confidence: 0 } // no transcript = can't validate, allow
  const hookNorm = normalizeText(hook)
  if (!hookNorm) return { match: true, confidence: 0 }
  const transcriptNorm = normalizeText(transcript)
  // exact substring
  if (transcriptNorm.includes(hookNorm)) return { match: true, confidence: 1 }
  // check first N words (6+ words) as substring
  const hookWords = hookNorm.split(' ')
  if (hookWords.length >= 4) {
    const firstFour = hookWords.slice(0, 4).join(' ')
    if (transcriptNorm.includes(firstFour)) return { match: true, confidence: 0.85 }
    const lastFour = hookWords.slice(-4).join(' ')
    if (transcriptNorm.includes(lastFour)) return { match: true, confidence: 0.85 }
  }
  // check 3-word windows
  for (let i = 0; i <= hookWords.length - 3; i++) {
    const window = hookWords.slice(i, i + 3).join(' ')
    if (transcriptNorm.includes(window)) return { match: true, confidence: 0.7 }
  }
  return { match: false, confidence: 0 }
}

// ---- Source-to-output time mapping (for render after cuts) ----

// Given cut ranges and a source time, return the output time (after removing cuts)
export function buildCutRemovalMap(cuts: { start: number; end: number }[], clipStart: number): { sourceStart: number; sourceEnd: number; outputDurationBefore: number }[] {
  const sorted = [...cuts].filter(c => c.end > c.start).sort((a, b) => a.start - b.start)
  const map: { sourceStart: number; sourceEnd: number; outputDurationBefore: number }[] = []
  let cumulativeRemoved = 0
  for (const cut of sorted) {
    map.push({
      sourceStart: cut.start,
      sourceEnd: cut.end,
      outputDurationBefore: (cut.start - clipStart) - cumulativeRemoved,
    })
    cumulativeRemoved += cut.end - cut.start
  }
  return map
}

// Convert source time → output time (subtract cut durations before this time)
export function sourceToOutputTime(sourceTime: number, cutMap: ReturnType<typeof buildCutRemovalMap>): number {
  let output = sourceTime
  for (const cut of cutMap) {
    if (sourceTime >= cut.sourceEnd) {
      // sourceTime is after this cut → subtract full cut duration
      output -= (cut.sourceEnd - cut.sourceStart)
    } else if (sourceTime > cut.sourceStart) {
      // sourceTime is inside this cut → clamp to cut start
      output = cut.sourceStart - (cut.sourceStart - (cutMap[cutMap.indexOf(cut) - 1]?.sourceEnd ?? 0))
      // simpler: output = cut.outputDurationBefore + clipStart... but let's compute directly
    }
  }
  return output
}

// Better implementation
export function sourceToOutputTimeV2(sourceTime: number, clipStart: number, cuts: { start: number; end: number }[]): number {
  const sorted = [...cuts].filter(c => c.end > c.start).sort((a, b) => a.start - b.start)
  let removedBefore = 0
  for (const cut of sorted) {
    if (sourceTime >= cut.end) {
      removedBefore += cut.end - cut.start
    } else if (sourceTime > cut.start) {
      // sourceTime is inside a cut → snap to cut start
      return (cut.start - clipStart) - removedBefore
    } else {
      break
    }
  }
  return sourceTime - clipStart - removedBefore
}

// ---- Rate limiting (in-memory, simple) ----

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()
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

// ---- Anonymous session (simple cookie-based) ----

export function getOrCreateSessionId(req: Request): string {
  // check cookie
  const cookies = req.headers.get('cookie') ?? ''
  const match = cookies.match(/clipforge-session=([^;]+)/)
  if (match) return match[1]
  // generate new
  return `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

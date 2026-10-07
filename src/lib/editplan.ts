// Types & helpers for the AI Creative Director edit-plan system

export interface ClipScores {
  hook: number // 0-10
  curiosity: number
  emotion: number
  payoff: number
  standalone: number
  shareability: number
  context_safety: number
  total: number // weighted 0-100
}

export type SegmentType =
  | 'HOOK'
  | 'CONTEXT'
  | 'DEVELOPMENT'
  | 'EXAMPLE'
  | 'CONTRAST'
  | 'PAYOFF'
  | 'CTA'

export interface EditSegment {
  type: SegmentType
  start: number
  end: number
  purpose: string
  subtitle: string
  emphasis_words: string[]
}

export interface Cut {
  start: number
  end: number
  reason: string
}

export interface CameraMove {
  start: number
  end: number
  scale_start: number
  scale_end: number
  reason: string
}

export type VisualType =
  | 'generated_image'
  | 'broll'
  | 'screenshot'
  | 'diagram'
  | 'icon'
  | 'text_card'
  | 'meme'
  | 'infographic'
  | 'stock_footage'

export interface VisualItem {
  type: VisualType
  start: number
  end: number
  purpose: string
  prompt: string
  aspect_ratio: string
  transition?: string
}

export type AnimationType =
  | 'fade'
  | 'slide'
  | 'pop'
  | 'scale'
  | 'bounce'
  | 'typewriter'
  | 'word_emphasis'
  | 'kinetic_typography'
  | 'freeze_frame'
  | 'highlight_box'
  | 'arrow'
  | 'underline'
  | 'progress_indicator'

export interface AnimationItem {
  type: AnimationType
  start: number
  end: number
  text?: string
  animation: string
}

export interface SoundEffect {
  type: string // whoosh | impact | pop | click | bass_hit | notification | record_scratch | crowd_reaction
  start: number
  duration: number
  intensity: number // 0-1
}

export interface MusicPlan {
  recommended: boolean
  style: string
  intensity: number // 0-1
  ducking_percent: number // 0-100
}

export type EmphasisType =
  | 'bold'
  | 'uppercase'
  | 'scale'
  | 'color'
  | 'background'
  | 'pop'

export interface SubtitleBlock {
  start: number
  end: number
  text: string
  emphasis_words: string[]
  emphasis_type?: EmphasisType
  /**
   * Real word timestamps inside this block (SOURCE time) — present ONLY when
   * the block text is composed of exactly those words (never fabricated).
   * Enables karaoke word-highlight rendering in the ASS burn-in.
   */
  word_timings?: { word: string; start: number; end: number }[]
}

export interface ClipCandidate {
  id: string
  start: number
  end: number
  duration: number
  title: string
  hook: string // spoken hook (from source)
  scores: ClipScores
  reason: string
  context_risk: boolean
  recommendation: 'POST' | 'SKIP'
}

export interface EditPlan {
  project: {
    title: string
    style: string
    platform: string
    target_duration: number
    aspect_ratio: string
  }
  analysis: {
    main_topic: string
    audience: string
    content_type: string
    overall_summary: string
  }
  selected_clip: {
    id: string
    start: number
    end: number
    duration: number
    title: string
    generated_hook: string
    segments: EditSegment[]
    cuts: Cut[]
    camera: CameraMove[]
    visuals: VisualItem[]
    animations: AnimationItem[]
    sound_effects: SoundEffect[]
    music: MusicPlan
    subtitles: SubtitleBlock[]
  }
}

export interface AnalyzeResult {
  candidates: ClipCandidate[]
  platform: string
  style: string
  targetDuration: number
  contentSummary: string
  estimatedDuration: number
}

// ---- Style presets ----
export interface StylePreset {
  id: string
  label: string
  desc: string
  icon: string
  accent: string
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'podcast',
    label: 'Podcast',
    desc: 'Clean, modern, readable subtitles, subtle punch-ins',
    icon: '🎙️',
    accent: 'text-violet-500',
  },
  {
    id: 'business',
    label: 'Business Talk',
    desc: 'Strong statement hooks, bold subtitles, premium look',
    icon: '💼',
    accent: 'text-emerald-500',
  },
  {
    id: 'educational',
    label: 'Educational',
    desc: 'Clean typography, diagrams, icons, keyword emphasis',
    icon: '📚',
    accent: 'text-sky-500',
  },
  {
    id: 'storytelling',
    label: 'Storytelling',
    desc: 'Narrative flow, emotional pacing, context-driven',
    icon: '📖',
    accent: 'text-amber-500',
  },
  {
    id: 'gaming',
    label: 'Gaming',
    desc: 'Fast pacing, strong punch-ins, impact effects, dynamic subs',
    icon: '🎮',
    accent: 'text-rose-500',
  },
  {
    id: 'funny',
    label: 'Funny Streamer',
    desc: 'Fast cuts, reaction zoom, meme visuals, comedic SFX',
    icon: '😂',
    accent: 'text-orange-500',
  },
  {
    id: 'motivational',
    label: 'Motivational',
    desc: 'Emotional payoff, cinematic pacing, bold typography',
    icon: '🔥',
    accent: 'text-red-500',
  },
  {
    id: 'news',
    label: 'News / Commentary',
    desc: 'Clean authority, text cards, minimal B-roll',
    icon: '📰',
    accent: 'text-cyan-500',
  },
]

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((s) => s.id === id)
}

// ---- score helpers ----
export function scoreColor10(v: number): { bg: string; text: string; label: string } {
  if (v >= 8.5) return { bg: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', label: 'Excellent' }
  if (v >= 7) return { bg: 'bg-lime-500/15', text: 'text-lime-600 dark:text-lime-400', label: 'Strong' }
  if (v >= 5) return { bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', label: 'OK' }
  if (v >= 3) return { bg: 'bg-orange-500/15', text: 'text-orange-600 dark:text-orange-400', label: 'Weak' }
  return { bg: 'bg-rose-500/15', text: 'text-rose-600 dark:text-rose-400', label: 'Poor' }
}

export const SCORE_DIMENSIONS: { key: keyof Omit<ClipScores, 'total'>; label: string; weight: number }[] = [
  { key: 'hook', label: 'Hook', weight: 0.2 },
  { key: 'curiosity', label: 'Curiosity', weight: 0.15 },
  { key: 'payoff', label: 'Payoff', weight: 0.2 },
  { key: 'standalone', label: 'Standalone', weight: 0.15 },
  { key: 'shareability', label: 'Shareable', weight: 0.15 },
  { key: 'emotion', label: 'Emotion', weight: 0.1 },
  { key: 'context_safety', label: 'Context Safe', weight: 0.05 },
]

export const SEGMENT_COLORS: Record<SegmentType, string> = {
  HOOK: 'bg-rose-500',
  CONTEXT: 'bg-sky-500',
  DEVELOPMENT: 'bg-violet-500',
  EXAMPLE: 'bg-amber-500',
  CONTRAST: 'bg-orange-500',
  PAYOFF: 'bg-emerald-500',
  CTA: 'bg-cyan-500',
}

export const SEGMENT_LABELS: Record<SegmentType, string> = {
  HOOK: 'Hook',
  CONTEXT: 'Context',
  DEVELOPMENT: 'Development',
  EXAMPLE: 'Example',
  CONTRAST: 'Contrast',
  PAYOFF: 'Payoff',
  CTA: 'CTA',
}

// ---- safe JSON parse helpers ----
export function safeJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    try {
      return JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')) as T
    } catch {
      return fallback
    }
  }
}

export function parseScores(raw: unknown): ClipScores {
  return safeJson<ClipScores>(raw, {
    hook: 0,
    curiosity: 0,
    emotion: 0,
    payoff: 0,
    standalone: 0,
    shareability: 0,
    context_safety: 0,
    total: 0,
  })
}

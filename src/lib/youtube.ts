// Shared types and helpers for ClipForge AI studio

export interface YouTubeMeta {
  youtubeId: string
  url: string
  title: string
  author: string | null
  thumbnail: string
  provider: string
  duration: number | null // REAL seconds or null (never guessed)
  durationSource?: string // 'yt-dlp' | 'innertube' | 'user-provided' | 'unavailable'
  requiresManualDuration?: boolean
  resolverErrors?: string[]
  description: string | null
  embedUrl: string
  embedUrlAutoplay: string
}

export interface SuggestedClip {
  id?: string
  title: string
  summary: string
  startTime: number
  endTime: number
  score: number
  tags: string[]
  hookText: string
  platform?: string
  status?: string
  order?: number
  // advanced edit-plan fields
  style?: string
  targetDuration?: number
  scores?: {
    hook: number
    curiosity: number
    emotion: number
    payoff: number
    standalone: number
    shareability: number
    context_safety: number
    total: number
  }
  contextRisk?: boolean
  contextStatus?: string // PASS | EXTEND | REJECT | UNKNOWN
  hookVerified?: boolean // spokenHook verified against transcript
  spokenHook?: string
  recommendation?: 'POST' | 'SKIP'
  generatedHook?: string
  reason?: string
  clipTranscript?: string
  clipWords?: { word: string; start: number; end: number }[]
  // detailed plan (parsed)
  segments?: unknown[]
  cuts?: unknown[]
  camera?: unknown[]
  visuals?: unknown[]
  animations?: unknown[]
  soundEffects?: unknown[]
  music?: { recommended: boolean; style: string; intensity: number; ducking_percent: number }
  subtitles?: unknown[]
  hasPlan?: boolean
}

export interface AnalyzeResult {
  candidates?: SuggestedClip[] // new shape
  clips?: SuggestedClip[] // legacy
  platform: string
  style?: string
  targetDuration?: number
  contentSummary: string
  estimatedDuration: number
  transcriptSource?: string
  transcriptGrounded?: boolean
  wordTiming?: 'measured' | 'estimated' | null
  meta?: {
    serverScored?: boolean
    requestedCount?: number
    returnedCount?: number
    promptVersion?: string
    analysisVersion?: string
  }
  analysis?: {
    main_topic: string
    audience: string
    content_type: string
    overall_summary: string
  }
}

export interface Project {
  id: string
  youtubeId: string
  url: string
  title: string
  author: string | null
  thumbnail: string | null
  description: string | null
  duration: number | null
  durationSource?: string
  transcriptSource?: string
  wordTiming?: 'measured' | 'estimated' | null
  status: string
  clipCount: number
  clips?: SuggestedClip[]
  createdAt: string
  updatedAt: string
}

export interface PlatformOption {
  id: string
  label: string
  range: [number, number]
  icon: string
}

export const PLATFORMS: PlatformOption[] = [
  { id: 'shorts', label: 'YouTube Shorts', range: [25, 60], icon: '⚡' },
  { id: 'reels', label: 'Instagram Reels', range: [15, 60], icon: '📸' },
  { id: 'tiktok', label: 'TikTok', range: [15, 60], icon: '🎵' },
  { id: 'custom', label: 'Custom / Long', range: [30, 180], icon: '✂️' },
]

export interface LanguageOption {
  id: string
  label: string
  flag: string
  native: string
}

export const LANGUAGES: LanguageOption[] = [
  { id: 'auto', label: 'Auto-detect', flag: '🌐', native: 'Match video language' },
  { id: 'en', label: 'English', flag: '🇬🇧', native: 'English' },
  { id: 'id', label: 'Indonesian', flag: '🇮🇩', native: 'Bahasa Indonesia' },
  { id: 'es', label: 'Spanish', flag: '🇪🇸', native: 'Español' },
  { id: 'pt', label: 'Portuguese', flag: '🇧🇷', native: 'Português' },
  { id: 'fr', label: 'French', flag: '🇫🇷', native: 'Français' },
  { id: 'de', label: 'German', flag: '🇩🇪', native: 'Deutsch' },
  { id: 'it', label: 'Italian', flag: '🇮🇹', native: 'Italiano' },
  { id: 'nl', label: 'Dutch', flag: '🇳🇱', native: 'Nederlands' },
  { id: 'ru', label: 'Russian', flag: '🇷🇺', native: 'Русский' },
  { id: 'ja', label: 'Japanese', flag: '🇯🇵', native: '日本語' },
  { id: 'ko', label: 'Korean', flag: '🇰🇷', native: '한국어' },
  { id: 'zh', label: 'Chinese', flag: '🇨🇳', native: '中文' },
  { id: 'ar', label: 'Arabic', flag: '🇸🇦', native: 'العربية' },
  { id: 'hi', label: 'Hindi', flag: '🇮🇳', native: 'हिन्दी' },
  { id: 'th', label: 'Thai', flag: '🇹🇭', native: 'ไทย' },
  { id: 'vi', label: 'Vietnamese', flag: '🇻🇳', native: 'Tiếng Việt' },
  { id: 'ms', label: 'Malay', flag: '🇲🇾', native: 'Bahasa Melayu' },
]

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec2 = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec2)}`
  return `${pad(m)}:${pad(sec2)}`
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`
}

export function scoreColor(score: number): {
  bg: string
  text: string
  ring: string
  label: string
} {
  if (score >= 85) return { bg: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', ring: 'ring-emerald-500/30', label: 'Viral' }
  if (score >= 70) return { bg: 'bg-lime-500/15', text: 'text-lime-600 dark:text-lime-400', ring: 'ring-lime-500/30', label: 'High' }
  if (score >= 50) return { bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/30', label: 'Good' }
  return { bg: 'bg-rose-500/15', text: 'text-rose-600 dark:text-rose-400', ring: 'ring-rose-500/30', label: 'Risky' }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/30'
    case 'edited':
      return 'bg-sky-500/15 text-sky-600 dark:text-sky-400 ring-1 ring-sky-500/30'
    case 'rejected':
      return 'bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-1 ring-rose-500/30'
    default:
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/30'
  }
}

// Sort & filter helpers
export type SortKey = 'default' | 'score-desc' | 'score-asc' | 'time-asc' | 'duration-desc'
export type FilterKey = 'all' | 'approved' | 'pending' | 'rejected' | 'edited'

export function sortClips(clips: SuggestedClip[], sort: SortKey): SuggestedClip[] {
  const copy = [...clips]
  switch (sort) {
    case 'score-desc':
      return copy.sort((a, b) => b.score - a.score)
    case 'score-asc':
      return copy.sort((a, b) => a.score - b.score)
    case 'time-asc':
      return copy.sort((a, b) => a.startTime - b.startTime)
    case 'duration-desc':
      return copy.sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))
    default:
      return copy
  }
}

export function filterClips(clips: SuggestedClip[], filter: FilterKey): SuggestedClip[] {
  switch (filter) {
    case 'approved':
      return clips.filter((c) => c.status === 'approved')
    case 'rejected':
      return clips.filter((c) => c.status === 'rejected')
    case 'edited':
      return clips.filter((c) => c.status === 'edited')
    case 'pending':
      return clips.filter((c) => !c.status || c.status === 'suggested')
    default:
      return clips
  }
}

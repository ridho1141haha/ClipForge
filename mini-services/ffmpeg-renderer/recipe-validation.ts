// ClipForge ffmpeg-renderer — STRICT RenderRecipe runtime validation.
//
// The renderer NEVER blindly trusts arbitrary JSON (security + stability):
// every render request passes through validateRecipe() before any ffmpeg work.
// This module is PURE (no I/O, no server) so the unit-test suite imports the
// exact same contract enforcement that runs in the mini-service.
//
// Documented resource limits (deliberately generous for legitimate use —
// a 30-minute 9:16 custom render is allowed; absurd/NaN payloads are not):

export const RECIPE_LIMITS = {
  /** max serialized recipe JSON size (bytes) */
  MAX_RECIPE_BYTES: 1 * 1024 * 1024, // 1 MiB
  /** max keep ranges (cuts) per recipe */
  MAX_KEEP_RANGES: 50,
  /** max camera keyframes */
  MAX_CAMERA_KEYFRAMES: 400,
  /** max .ass subtitle payload (bytes) */
  MAX_ASS_BYTES: 512 * 1024,
  /** max total output duration after cuts (seconds) */
  MAX_OUTPUT_DURATION: 1800, // 30 min
  /** min total output duration (seconds) — an empty edit is rejected */
  MIN_OUTPUT_DURATION: 0.2,
  /** zoompan scale bounds */
  MIN_SCALE: 0.5,
  MAX_SCALE: 10,
  /** max upload size (bytes) — enforced on POST /render content-length */
  MAX_UPLOAD_BYTES: 1500 * 1024 * 1024, // 1.5 GB
} as const

export type RecipeValidationCode =
  | 'NOT_OBJECT'
  | 'RECIPE_TOO_LARGE'
  | 'EMPTY_OUTPUT'
  | 'INVALID_KEEP_RANGES'
  | 'INVALID_DURATION'
  | 'INVALID_CAMERA'
  | 'INVALID_ASS'
  | 'INVALID_SOURCE'
  | 'INVALID_COVER'
  | 'INVALID_QUALITY'
  | 'LIMIT_EXCEEDED'

// ---- Render quality presets --------------------------------------------------
// The recipe may carry a quality hint; the renderer maps it to concrete ffmpeg
// parameters. 'standard' is the historical default (1080x1920 · crf 20 · 128k
// · 30fps) so every existing recipe/test renders EXACTLY as before.
//   draft    — 720x1280, crf 26, 96k audio, 24fps: ~2-3x faster, ~4x smaller
//              files (preview/iteration quality; 24fps is a fully standard
//              playback rate for every short-form platform and cuts another
//              ~20% of encode frames on top of the resolution savings)
//   standard — 1080x1920, crf 20, 128k audio, 30fps (balanced default)
//   high     — 1080x1920, crf 16, 192k audio, 30fps: max fidelity, larger files
// NOTE: keep src/lib/render-recipe.ts (client mirror: labels/copy) in sync when
// changing these presets.
export type RenderQuality = 'draft' | 'standard' | 'high'

export const QUALITY_PRESETS: Record<RenderQuality, {
  width: number
  height: number
  crf: number
  videoPreset: 'veryfast'
  audioBitrate: string
  /** output frame rate — drives the zoompan frame math AND -r (must match) */
  fps: number
}> = {
  draft: { width: 720, height: 1280, crf: 26, videoPreset: 'veryfast', audioBitrate: '96k', fps: 24 },
  standard: { width: 1080, height: 1920, crf: 20, videoPreset: 'veryfast', audioBitrate: '128k', fps: 30 },
  high: { width: 1080, height: 1920, crf: 16, videoPreset: 'veryfast', audioBitrate: '192k', fps: 30 },
}

export function isRenderQuality(v: unknown): v is RenderQuality {
  return v === 'draft' || v === 'standard' || v === 'high'
}

export interface ValidatedRecipe {
  source?: { youtube_id?: string; clip_start?: number; clip_end?: number }
  keep_ranges: { start: number; end: number }[]
  subtitles_ass?: string
  camera_keyframes: { time: number; scale: number }[]
  sound_effects?: { type: string; start: number; duration: number; intensity: number }[]
  music?: { recommended: boolean; style: string; intensity: number; ducking_percent: number }
  segments?: { type: string; start: number; end: number }[]
  /** optional cover-frame request — OUTPUT-time second to grab as the Short's cover JPG */
  cover?: { timestamp: number }
  /** render quality preset — always set after validation (default 'standard') */
  quality: RenderQuality
  title?: string
  duration: number
}

export type ValidateResult =
  | { ok: true; recipe: ValidatedRecipe }
  | { ok: false; code: RecipeValidationCode; error: string }

const L = RECIPE_LIMITS

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate + normalize an untrusted recipe.
 * Rejects: non-objects, oversized payloads, NaN/Infinity (JSON can carry them
 * via 1e999), negative timestamps, end <= start, overlapping/unsorted keep
 * ranges, empty output (entire clip cut away), impossible durations, absurd
 * counts, malformed camera keyframes (incl. filter-expression injection via
 * non-numeric scale), oversized ASS.
 */
export function validateRecipe(raw: unknown): ValidateResult {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'NOT_OBJECT', error: 'Recipe must be a JSON object' }
  }

  // ---- keep_ranges: REQUIRED, non-empty (full-cut = EMPTY_OUTPUT, never a
  // silent fallback to the full clip), sorted, non-overlapping, valid times ----
  const kr = raw.keep_ranges
  if (!Array.isArray(kr) || kr.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_OUTPUT',
      error: 'Recipe has no keep ranges — the edit produces no output (entire clip cut away or recipe malformed)',
    }
  }
  if (kr.length > L.MAX_KEEP_RANGES) {
    return {
      ok: false,
      code: 'LIMIT_EXCEEDED',
      error: `Too many keep ranges (${kr.length} > ${L.MAX_KEEP_RANGES})`,
    }
  }
  const keep: { start: number; end: number }[] = []
  let total = 0
  let prevEnd = -1
  for (let i = 0; i < kr.length; i++) {
    const r = kr[i]
    if (!isPlainObject(r) || !isFiniteNum(r.start) || !isFiniteNum(r.end)) {
      return { ok: false, code: 'INVALID_KEEP_RANGES', error: `keep_ranges[${i}] must have finite numeric start/end` }
    }
    if (r.start < 0) {
      return { ok: false, code: 'INVALID_KEEP_RANGES', error: `keep_ranges[${i}].start is negative (${r.start})` }
    }
    if (r.end <= r.start) {
      return { ok: false, code: 'INVALID_KEEP_RANGES', error: `keep_ranges[${i}] has end <= start (${r.start}..${r.end})` }
    }
    if (r.end - r.start > L.MAX_OUTPUT_DURATION) {
      return { ok: false, code: 'LIMIT_EXCEEDED', error: `keep_ranges[${i}] exceeds the ${L.MAX_OUTPUT_DURATION}s output cap` }
    }
    if (r.start < prevEnd - 1e-6) {
      return { ok: false, code: 'INVALID_KEEP_RANGES', error: `keep_ranges must be sorted and non-overlapping (range ${i} starts before range ${i - 1} ends)` }
    }
    prevEnd = r.end
    total += r.end - r.start
    keep.push({ start: r.start, end: r.end })
  }
  if (total > L.MAX_OUTPUT_DURATION) {
    return { ok: false, code: 'LIMIT_EXCEEDED', error: `Total output duration ${total.toFixed(1)}s exceeds the ${L.MAX_OUTPUT_DURATION}s cap` }
  }
  if (total < L.MIN_OUTPUT_DURATION) {
    return { ok: false, code: 'EMPTY_OUTPUT', error: `Output duration after cuts is ${total.toFixed(2)}s — below the ${L.MIN_OUTPUT_DURATION}s minimum` }
  }

  // ---- duration: finite, consistent with keep ranges (renderer progress +
  // durationOk depend on it) ----
  let duration = total
  if (raw.duration !== undefined) {
    if (!isFiniteNum(raw.duration) || raw.duration <= 0) {
      return { ok: false, code: 'INVALID_DURATION', error: `duration must be a positive finite number (got ${String(raw.duration)})` }
    }
    if (raw.duration > L.MAX_OUTPUT_DURATION) {
      return { ok: false, code: 'LIMIT_EXCEEDED', error: `duration ${raw.duration}s exceeds the ${L.MAX_OUTPUT_DURATION}s cap` }
    }
    if (Math.abs(raw.duration - total) > 1.0) {
      return { ok: false, code: 'INVALID_DURATION', error: `duration (${raw.duration.toFixed(2)}s) disagrees with keep-range sum (${total.toFixed(2)}s)` }
    }
    duration = raw.duration
  }

  // ---- camera_keyframes: finite times, scale strictly numeric (a string here
  // would inject into the zoompan z='...' filter expression) ----
  let camera: { time: number; scale: number }[] = []
  if (raw.camera_keyframes !== undefined && raw.camera_keyframes !== null) {
    if (!Array.isArray(raw.camera_keyframes)) {
      return { ok: false, code: 'INVALID_CAMERA', error: 'camera_keyframes must be an array' }
    }
    if (raw.camera_keyframes.length > L.MAX_CAMERA_KEYFRAMES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', error: `Too many camera keyframes (${raw.camera_keyframes.length} > ${L.MAX_CAMERA_KEYFRAMES})` }
    }
    for (let i = 0; i < raw.camera_keyframes.length; i++) {
      const kf = raw.camera_keyframes[i]
      if (!isPlainObject(kf) || !isFiniteNum(kf.time) || !isFiniteNum(kf.scale)) {
        return { ok: false, code: 'INVALID_CAMERA', error: `camera_keyframes[${i}] must have finite numeric time/scale` }
      }
      if (kf.time < 0) {
        return { ok: false, code: 'INVALID_CAMERA', error: `camera_keyframes[${i}].time is negative` }
      }
      if (kf.scale < L.MIN_SCALE || kf.scale > L.MAX_SCALE) {
        return { ok: false, code: 'INVALID_CAMERA', error: `camera_keyframes[${i}].scale ${kf.scale} outside allowed [${L.MIN_SCALE}, ${L.MAX_SCALE}]` }
      }
      camera.push({ time: kf.time, scale: kf.scale })
    }
    camera.sort((a, b) => a.time - b.time)
  }

  // ---- subtitles_ass: optional, size-capped (it is written to disk verbatim) ----
  let ass: string | undefined
  if (raw.subtitles_ass !== undefined && raw.subtitles_ass !== null) {
    if (typeof raw.subtitles_ass !== 'string') {
      return { ok: false, code: 'INVALID_ASS', error: 'subtitles_ass must be a string' }
    }
    if (Buffer.byteLength(raw.subtitles_ass, 'utf8') > L.MAX_ASS_BYTES) {
      return { ok: false, code: 'LIMIT_EXCEEDED', error: `subtitles_ass exceeds ${L.MAX_ASS_BYTES} bytes` }
    }
    ass = raw.subtitles_ass
  }

  // ---- source: optional provenance block ----
  let source: ValidatedRecipe['source']
  if (raw.source !== undefined && raw.source !== null) {
    if (!isPlainObject(raw.source)) {
      return { ok: false, code: 'INVALID_SOURCE', error: 'source must be an object' }
    }
    source = {}
    if (raw.source.youtube_id !== undefined) {
      if (typeof raw.source.youtube_id !== 'string' || raw.source.youtube_id.length > 64) {
        return { ok: false, code: 'INVALID_SOURCE', error: 'source.youtube_id must be a short string' }
      }
      source.youtube_id = raw.source.youtube_id
    }
    for (const k of ['clip_start', 'clip_end'] as const) {
      const v = raw.source[k]
      if (v !== undefined) {
        if (!isFiniteNum(v) || v < 0) {
          return { ok: false, code: 'INVALID_SOURCE', error: `source.${k} must be a finite non-negative number` }
        }
        source[k] = v
      }
    }
    if (source.clip_start !== undefined && source.clip_end !== undefined && source.clip_end <= source.clip_start) {
      return { ok: false, code: 'INVALID_SOURCE', error: 'source.clip_end must be greater than clip_start' }
    }
  }

  // ---- auxiliary arrays: not used for rendering, but size-capped anyway ----
  const capArray = (v: unknown, name: string, max: number): string | null => {
    if (v === undefined || v === null) return null
    if (!Array.isArray(v) || v.length > max) return `${name} must be an array with at most ${max} entries`
    return null
  }
  const auxErr = capArray(raw.sound_effects, 'sound_effects', 200) ?? capArray(raw.segments, 'segments', 200)
  if (auxErr) return { ok: false, code: 'LIMIT_EXCEEDED', error: auxErr }

  // ---- cover: optional cover-frame request (OUTPUT time). Must be a finite
  // number within the output duration (+1s tolerance, same slop as the
  // duration consistency check). The extractor clamps to [0, duration]. ----
  let cover: ValidatedRecipe['cover']
  if (raw.cover !== undefined && raw.cover !== null) {
    if (!isPlainObject(raw.cover) || !isFiniteNum(raw.cover.timestamp)) {
      return { ok: false, code: 'INVALID_COVER', error: 'cover must be an object with a finite numeric timestamp' }
    }
    if (raw.cover.timestamp < 0) {
      return { ok: false, code: 'INVALID_COVER', error: `cover.timestamp is negative (${raw.cover.timestamp})` }
    }
    if (raw.cover.timestamp > duration + 1.0) {
      return { ok: false, code: 'INVALID_COVER', error: `cover.timestamp (${raw.cover.timestamp}s) is beyond the output duration (${duration.toFixed(2)}s)` }
    }
    cover = { timestamp: raw.cover.timestamp }
  }

  // ---- quality: optional enum, default 'standard' (historical behavior).
  // Anything else is rejected — never silently coerced. ----
  let quality: RenderQuality = 'standard'
  if (raw.quality !== undefined && raw.quality !== null) {
    if (!isRenderQuality(raw.quality)) {
      return { ok: false, code: 'INVALID_QUALITY', error: `quality must be one of "draft", "standard", "high" (got ${String(raw.quality)})` }
    }
    quality = raw.quality
  }

  // ---- title: bounded (it feeds the output filename via sanitize) ----
  let title: string | undefined
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string') return { ok: false, code: 'NOT_OBJECT', error: 'title must be a string' }
    title = raw.title.slice(0, 300)
  }

  return {
    ok: true,
    recipe: {
      source,
      keep_ranges: keep,
      subtitles_ass: ass,
      camera_keyframes: camera,
      sound_effects: Array.isArray(raw.sound_effects) ? (raw.sound_effects as ValidatedRecipe['sound_effects']) : undefined,
      music: isPlainObject(raw.music) ? (raw.music as ValidatedRecipe['music']) : undefined,
      segments: Array.isArray(raw.segments) ? (raw.segments as ValidatedRecipe['segments']) : undefined,
      cover,
      quality,
      title,
      duration: Math.round(duration * 1000) / 1000,
    },
  }
}

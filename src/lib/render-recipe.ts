// Render recipe: convert an AI edit plan into concrete render instructions
// (used by the in-browser AutoEditPlayer AND the ffmpeg shell-script generator)
//
// ─── ARCHITECTURE CONTRACT ──────────────────────────────────────────────────
//   EditPlan (AI, SOURCE_TIME)
//        ↓  buildRenderRecipe()          ← the ONLY plan→recipe translation
//   RenderRecipe
//        ↓  buildRecipeJSON() / generateASS() / generateFFmpegScript()
//   Renderer (mini-service ffmpeg-renderer, shell script, future cloud worker)
//
// RULES (do not break):
//   1. The renderer NEVER imports UI code, AI code, or DB models. It consumes
//      only the recipe JSON produced here.
//   2. The UI NEVER builds ffmpeg commands or filter graphs. It renders
//      previews from RenderRecipe via scaleAtTime/subtitleAtTime helpers.
//   3. recipe.camera_keyframes in recipe JSON are OUTPUT-time (pre-mapped);
//      cameraKeyframes on the RenderRecipe object are SOURCE-time.
//   4. All timeline conversion goes through src/lib/subtitles.ts — one
//      canonical SOURCE↔OUTPUT mapping, bounded to [clipStart, clipEnd].
//   5. Swapping the renderer (cloud FFmpeg worker, GPU, Remotion) must only
//      require implementing "recipe JSON → MP4", nothing else.
// ─────────────────────────────────────────────────────────────────────────────
//
// TIMELINE SYSTEMS (Phase 13):
//   The edit plan uses SOURCE_TIME (absolute seconds in the original video).
//   The renderer works in OUTPUT_TIME (after cuts are removed).
//   ALL conversions go through sourceToOutputTime / outputToSourceTime in
//   src/lib/subtitles.ts — no naive `t - clipStart` subtraction anywhere.

import type { EditPlan } from '@/lib/editplan'
import { buildKeepRanges, isDroppedByCuts, outputToSourceTime, sourceToOutputTime } from '@/lib/subtitles'

// ---- Render quality (client mirror of the renderer's recipe contract) ------
// The recipe JSON may carry `quality: 'draft' | 'standard' | 'high'`; the
// ffmpeg renderer maps it to dims/crf/audio-bitrate/fps (see
// mini-services/ffmpeg-renderer/recipe-validation.ts QUALITY_PRESETS — keep
// the labels here in sync when presets change). Default 'standard' = the
// historical 1080×1920 · crf 20 · 128k · 30fps render, byte-identical behavior
// for every existing recipe/test.
export type RenderQuality = 'draft' | 'standard' | 'high'
export const RENDER_QUALITIES: { id: RenderQuality; label: string; dims: string; hint: string }[] = [
  { id: 'draft', label: 'Draft', dims: '720×1280', hint: 'Fastest — quick previews (24fps)' },
  { id: 'standard', label: 'Standard', dims: '1080×1920', hint: 'Balanced default' },
  { id: 'high', label: 'High', dims: '1080×1920', hint: 'Max fidelity — larger files' },
]
/** Full preset facts (the renderer's encoder settings per quality) — keep in
 *  sync with mini-services/ffmpeg-renderer/recipe-validation.ts QUALITY_PRESETS.
 *  Consumed by the export JSON so downstream tools see the real encoder
 *  contract instead of a stale hardcoded row. */
export const RENDER_QUALITY_PRESETS: Record<
  RenderQuality,
  { width: number; height: number; crf: number; videoPreset: string; audioBitrate: string; fps: number }
> = {
  draft: { width: 720, height: 1280, crf: 26, videoPreset: 'veryfast', audioBitrate: '96k', fps: 24 },
  standard: { width: 1080, height: 1920, crf: 20, videoPreset: 'veryfast', audioBitrate: '128k', fps: 30 },
  high: { width: 1080, height: 1920, crf: 16, videoPreset: 'veryfast', audioBitrate: '192k', fps: 30 },
}
export function isRenderQuality(v: unknown): v is RenderQuality {
  return v === 'draft' || v === 'standard' || v === 'high'
}

export interface RenderRecipe {
  clipId: string
  clipStart: number
  clipEnd: number
  duration: number
  youtubeId: string
  // cuts as "skip ranges" (absolute SOURCE seconds)
  cuts: { start: number; end: number; reason: string }[]
  // camera scale keyframes in SOURCE time (preview + mapping input)
  cameraKeyframes: { time: number; scale: number }[]
  // subtitles in SOURCE time (from the plan — transcript-grounded)
  subtitles: {
    start: number
    end: number
    text: string
    emphasis_words: string[]
    emphasis_type?: string
    /** real word timings inside the block (SOURCE time) — only present when verified */
    word_timings?: { word: string; start: number; end: number }[]
  }[]
  // segments (absolute SOURCE timestamps)
  segments: { type: string; start: number; end: number; purpose: string }[]
  // visuals — RECOMMENDATION ONLY (not rendered)
  visuals: {
    type: string
    start: number
    end: number
    purpose: string
    prompt: string
    aspect_ratio: string
  }[]
  // sound effects — RECOMMENDATION ONLY (not rendered)
  soundEffects: { type: string; start: number; duration: number; intensity: number }[]
  music: { recommended: boolean; style: string; intensity: number; ducking_percent: number }
  generatedHook: string
  title: string
}

export function buildRenderRecipe(plan: EditPlan, youtubeId: string): RenderRecipe {
  const sc = plan.selected_clip
  return {
    clipId: sc.id,
    clipStart: sc.start,
    clipEnd: sc.end,
    duration: sc.duration || sc.end - sc.start,
    youtubeId,
    cuts: sc.cuts,
    cameraKeyframes: [
      ...sc.camera.map((c) => ({ time: c.start, scale: c.scale_start })),
      ...sc.camera.map((c) => ({ time: c.end, scale: c.scale_end })),
    ],
    subtitles: sc.subtitles,
    segments: sc.segments.map((s) => ({
      type: s.type,
      start: s.start,
      end: s.end,
      purpose: s.purpose,
    })),
    visuals: sc.visuals.map((v) => ({
      type: v.type,
      start: v.start,
      end: v.end,
      purpose: v.purpose,
      prompt: v.prompt,
      aspect_ratio: v.aspect_ratio,
    })),
    soundEffects: sc.sound_effects,
    music: sc.music,
    generatedHook: sc.generated_hook,
    title: sc.title,
  }
}

// Get current camera scale at a given absolute SOURCE time (linear interp)
export function scaleAtTime(time: number, keyframes: { time: number; scale: number }[]): number {
  if (keyframes.length === 0) return 1
  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  if (time <= sorted[0].time) return sorted[0].scale
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].scale
  let prev = sorted[0]
  let next = sorted[sorted.length - 1]
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].time <= time && sorted[i + 1].time >= time) {
      prev = sorted[i]
      next = sorted[i + 1]
      break
    }
  }
  if (prev.time === next.time) return prev.scale
  const t = (time - prev.time) / (next.time - prev.time)
  return prev.scale + (next.scale - prev.scale) * t
}

// Check if a time falls inside a cut range
export function isInCut(time: number, cuts: { start: number; end: number }[]): { cut: { start: number; end: number } | null } {
  for (const c of cuts) {
    if (time >= c.start && time < c.end) return { cut: c }
  }
  return { cut: null }
}

// Get the current active subtitle at a SOURCE time
export function subtitleAtTime<T extends { start: number; end: number }>(
  time: number,
  subs: T[],
): T | null {
  return subs.find((s) => time >= s.start && time < s.end) ?? null
}

// Get the current segment at a SOURCE time
export function segmentAtTime<T extends { start: number; end: number }>(
  time: number,
  segs: T[],
): T | null {
  return segs.find((s) => time >= s.start && time < s.end) ?? null
}

// Get active visual at a SOURCE time (preview only)
export function visualAtTime<T extends { start: number; end: number }>(
  time: number,
  visuals: T[],
): T | null {
  return visuals.find((v) => time >= v.start && time < v.end) ?? null
}

// Synthesize a sound effect via Web Audio API (browser PREVIEW only)
export function playSoundEffect(
  ctx: AudioContext,
  type: string,
  intensity: number,
) {
  const now = ctx.currentTime
  const vol = Math.max(0.1, Math.min(1, intensity))
  if (type === 'whoosh') {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(200, now)
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.3)
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(vol * 0.3, now + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
    osc.connect(g).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.3)
  } else if (type === 'impact' || type === 'bass_hit') {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, now)
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.25)
    g.gain.setValueAtTime(vol * 0.6, now)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
    osc.connect(g).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.4)
  } else if (type === 'pop') {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(400, now)
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.08)
    g.gain.setValueAtTime(vol * 0.4, now)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
    osc.connect(g).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.12)
  } else if (type === 'click') {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 1000
    g.gain.setValueAtTime(vol * 0.2, now)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
    osc.connect(g).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.05)
  } else if (type === 'notification') {
    ;[880, 1320].forEach((f, i) => {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      g.gain.setValueAtTime(0.0001, now + i * 0.12)
      g.gain.exponentialRampToValueAtTime(vol * 0.3, now + i * 0.12 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.18)
      osc.connect(g).connect(ctx.destination)
      osc.start(now + i * 0.12)
      osc.stop(now + i * 0.12 + 0.2)
    })
  } else if (type === 'record_scratch') {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(440, now)
    osc.frequency.linearRampToValueAtTime(200, now + 0.1)
    osc.frequency.linearRampToValueAtTime(600, now + 0.2)
    osc.frequency.linearRampToValueAtTime(150, now + 0.35)
    g.gain.setValueAtTime(vol * 0.3, now)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
    osc.connect(g).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.4)
  } else if (type === 'crowd_reaction') {
    const bufferSize = ctx.sampleRate * 0.6
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize)
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1500
    const g = ctx.createGain()
    g.gain.value = vol * 0.2
    noise.connect(filter).connect(g).connect(ctx.destination)
    noise.start(now)
    noise.stop(now + 0.6)
  }
}

// ---- ffmpeg script/ASS generation (OUTPUT_TIME correct) ----

export function timeToFFmpeg(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${pad(h)}:${pad(m)}:${pad(si)}.${pad(ms, 3)}`
}

/**
 * Canonical ASS timestamp: H:MM:SS.cc (single-digit hour, 2-digit centiseconds).
 * libass MISPARSES other formats (e.g. HH:MM:SS.mmm) — verified empirically,
 * events then linger past their end time. Never use timeToFFmpeg() for ASS.
 */
export function timeToAss(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const cs = Math.round((s - Math.floor(s)) * 100)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${h}:${pad(m)}:${pad(si)}.${pad(Math.min(99, cs), 2)}`
}

// Drop events that are (mostly) inside removed ranges — canonical rule from
// src/lib/subtitles.ts (single definition; no duplicate logic here).
const droppedByCuts = isDroppedByCuts

// Generate an .ass subtitle file with emphasis styling.
// Times are converted SOURCE → OUTPUT (cuts removed) — Phase 13 correctness.
export function generateASS(
  recipe: RenderRecipe,
  options: { fontSize?: number; primaryColor?: string; outlineColor?: string } = {},
): string {
  const fs = options.fontSize ?? 48
  const primary = options.primaryColor ?? '&H00E8E8E8' // ASS BGR
  const outline = options.outlineColor ?? '&H00000000'
  const header = `[Script Info]
Script Type: V4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,${fs},${primary},&H00969696,${outline},&H64000000,1,0,0,0,100,100,0,0,1,3,2,2,80,80,120,1
Style: Emphasis,Inter,${fs},&H0000E8FF,&H00969696,${outline},&H64000000,1,1,0,0,100,100,0,0,1,3,2,2,80,80,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events = recipe.subtitles
    .filter((s) => !droppedByCuts(s.start, s.end, recipe.clipStart, recipe.clipEnd, recipe.cuts))
    .map((s) => {
      const outStart = sourceToOutputTime(s.start, recipe.clipStart, recipe.cuts)
      const outEnd = sourceToOutputTime(s.end, recipe.clipStart, recipe.cuts)
      if (outEnd - outStart < 0.15) return null
      // karaoke word-highlight when REAL word timings survived verification;
      // plain emphasis rendering otherwise
      const text = buildKaraokeText(s, recipe) ?? applyASSEmphasis(s.text, s.emphasis_words, s.emphasis_type)
      return `Dialogue: 0,${timeToAss(outStart)},${timeToAss(outEnd)},Default,,0,0,0,,${text}`
    })
    .filter((l): l is string => l !== null)
    .join('\n')
  // generated hook overlay as a title card at output start — {\an8} pins it
  // TOP-CENTER so it never collides with bottom-centered subtitles (0-3s)
  const hookLines = recipe.generatedHook
    ? `Dialogue: 1,${timeToAss(0)},${timeToAss(3)},Emphasis,,0,0,0,,{\\an8}${escapeASS(recipe.generatedHook)}\n`
    : ''
  return header + hookLines + events + '\n'
}

function escapeASS(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N')
}

/**
 * Build a karaoke (\k) line from REAL word timings — the word-highlight effect
 * standard in short-form captions: each word lights up exactly when spoken.
 *
 * \k durations are SEQUENTIAL (each segment runs from the previous tag), so
 * fill durations are the deltas between consecutive mapped word STARTS — gaps
 * between words are absorbed into the preceding word's fill and the line stays
 * in sync with speech.
 *
 * Returns null (→ plain text fallback) when timings are absent, degenerate,
 * non-monotonic, or any word boundary would be time-snapped by a cut — karaoke
 * must never misrepresent WHEN a word was spoken.
 */
export function buildKaraokeText(
  s: RenderRecipe['subtitles'][number],
  recipe: RenderRecipe,
): string | null {
  const wt = s.word_timings
  if (!wt || wt.length < 2) return null
  for (const w of wt) {
    if (!isFinite(w.start) || !isFinite(w.end) || w.end <= w.start) return null
    if (w.start < s.start - 0.01 || w.end > s.end + 0.01) return null // outside block
    if (isInCut(w.start, recipe.cuts).cut || isInCut(w.end, recipe.cuts).cut) return null // snapped by cut
  }
  for (let i = 1; i < wt.length; i++) {
    if (wt[i].start < wt[i - 1].start) return null // not monotonic
  }
  const mapped = wt.map((w) => ({
    word: w.word,
    s: sourceToOutputTime(w.start, recipe.clipStart, recipe.cuts),
    e: sourceToOutputTime(w.end, recipe.clipStart, recipe.cuts),
  }))
  const emph = s.emphasis_words ?? []
  const parts: string[] = []
  for (let i = 0; i < mapped.length; i++) {
    const segEnd = i < mapped.length - 1 ? mapped[i + 1].s : mapped[i].e
    const cs = Math.round((segEnd - mapped[i].s) * 100)
    if (!isFinite(cs) || cs <= 0) return null
    const isEmph = emph.some((e) => mapped[i].word.toLowerCase().includes(String(e).toLowerCase()))
    const tag = `${isEmph ? '{\\b1}' : ''}{\\k${Math.min(9999, Math.max(1, cs))}}${escapeASS(mapped[i].word)}${isEmph ? '{\\b0}' : ''}`
    parts.push(tag)
  }
  return parts.join(' ')
}

function applyASSEmphasis(text: string, words: string[], type?: string): string {
  if (!words || words.length === 0) return escapeASS(text)
  let result = ''
  const lower = text.toLowerCase()
  let pos = 0
  const matches: { start: number; end: number }[] = []
  words.forEach((w) => {
    const wl = w.toLowerCase()
    let idx = lower.indexOf(wl, pos)
    while (idx !== -1) {
      matches.push({ start: idx, end: idx + w.length })
      idx = lower.indexOf(wl, idx + 1)
    }
  })
  matches.sort((a, b) => a.start - b.start)
  let cursor = 0
  const seen = new Set<number>()
  matches.forEach((m) => {
    if (m.start < cursor || seen.has(m.start)) return
    result += escapeASS(text.slice(cursor, m.start))
    let prefix = ''
    if (type === 'uppercase') prefix = '{\\fs' + Math.round(48 * 1.2) + '}'
    else if (type === 'color') prefix = '{\\c&H0000E8FF&}'
    else if (type === 'background') prefix = '{\\3c&H0000E8FF&\\3a&HFF&}'
    else if (type === 'pop') prefix = '{\\fscx120\\fscy120}'
    else prefix = '{\\b1}'
    result += prefix + escapeASS(text.slice(m.start, m.end)) + '{\\r}'
    cursor = m.end
    seen.add(m.start)
  })
  if (cursor < text.length) result += escapeASS(text.slice(cursor))
  return result
}

/** Output-time duration of the clip after cuts. */
function outputDuration(recipe: RenderRecipe): number {
  const keep = buildKeepRanges(recipe.clipStart, recipe.clipEnd, recipe.cuts)
  return keep.reduce((acc, r) => acc + (r.end - r.start), 0)
}

/**
 * Build ffmpeg zoompan filter from camera keyframes.
 * OUTPUT frame index → OUTPUT time → (inverse map) → SOURCE time → scale.
 * This keeps punch-ins synchronized after cuts are removed (Phase 13).
 */
export function buildZoompanFilter(recipe: RenderRecipe, fps = 30): string | null {
  const kfs = recipe.cameraKeyframes
  if (!kfs || kfs.length < 2) return null
  const outDur = outputDuration(recipe)
  const totalFrames = Math.max(1, Math.round(outDur * fps))
  const scales: number[] = []
  for (let f = 0; f < totalFrames; f++) {
    const outT = f / fps
    const srcT = outputToSourceTime(outT, recipe.clipStart, recipe.cuts, recipe.clipEnd)
    scales.push(scaleAtTime(srcT, kfs))
  }
  const maxScale = Math.max(...scales, 1)
  const minScale = Math.min(...scales, 1)
  if (Math.abs(maxScale - minScale) < 0.01) return null
  const step = Math.max(1, Math.floor(totalFrames / 20))
  const samples: { frame: number; scale: number }[] = []
  for (let f = 0; f < totalFrames; f += step) samples.push({ frame: f, scale: scales[f] })
  samples.push({ frame: totalFrames, scale: scales[totalFrames - 1] })
  let expr = samples[samples.length - 1].scale.toFixed(3)
  for (let i = samples.length - 2; i >= 0; i--) {
    expr = `if(lt(on,${samples[i].frame}),${samples[i].scale.toFixed(3)},${expr})`
  }
  return `zoompan=z='${expr}':d=1:s=1080x1920:fps=${fps}`
}

// Generate a complete ffmpeg shell script that performs the edit
export function generateFFmpegScript(
  recipe: RenderRecipe,
  options: { inputVar?: string; outputFile?: string; youtubeUrl?: string } = {},
): string {
  const output = options.outputFile ?? `clipforge_${sanitize(recipe.title)}.mp4`
  const assPath = `clipforge_${sanitize(recipe.title)}.ass`
  const youtubeUrl = options.youtubeUrl

  const keepRanges = buildKeepRanges(recipe.clipStart, recipe.clipEnd, recipe.cuts)

  const lines: string[] = []
  lines.push('#!/bin/bash')
  lines.push('# ClipForge AI — Auto-Edit Render Script')
  lines.push(`# Clip: "${recipe.title}"`)
  lines.push(`# Source range: ${timeToFFmpeg(recipe.clipStart)} -> ${timeToFFmpeg(recipe.clipEnd)}`)
  lines.push(`# Cuts: ${recipe.cuts.length} | Output duration after cuts: ${outputDuration(recipe).toFixed(1)}s`)
  lines.push(`# Subtitles: ${recipe.subtitles.length} (SOURCE→OUTPUT mapped) | Camera moves: ${recipe.cameraKeyframes.length / 2}`)
  lines.push('# RENDERED: cuts, subtitle burn-in, camera punch-in, 9:16 crop, H.264+AAC')
  lines.push('# PREVIEW-ONLY (not rendered): B-roll/visuals, animations, SFX, music')
  lines.push('#')
  if (youtubeUrl) {
    lines.push('# Usage (yt-dlp auto-download):')
    lines.push('#   bash ' + output.replace('.mp4', '.sh'))
    lines.push('#')
    lines.push('# Usage (local file):')
    lines.push('#   INPUT=path/to/source.mp4 bash ' + output.replace('.mp4', '.sh'))
    lines.push('#')
    lines.push('# Source video: ' + youtubeUrl)
  } else {
    lines.push('# Usage:')
    lines.push('#   INPUT=path/to/source.mp4 bash ' + output.replace('.mp4', '.sh'))
  }
  lines.push('#')
  lines.push('set -euo pipefail')

  lines.push('OUTPUT="' + output + '"')
  lines.push('ASS="' + assPath + '"')
  lines.push('INPUT="${INPUT:-}"')
  lines.push('')
  if (youtubeUrl) {
    lines.push('# 0. Resolve input: try yt-dlp auto-download, else require INPUT')
    lines.push('if [ -z "$INPUT" ]; then')
    lines.push('  if command -v yt-dlp >/dev/null 2>&1; then')
    lines.push('    echo "📥 Downloading source via yt-dlp…"')
    lines.push(`    yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "source.%(ext)s" "${youtubeUrl}"`)
    lines.push('    INPUT=$(ls source.mp4 2>/dev/null || ls source.* | head -1)')
    lines.push('    CLEANUP_SOURCE=1')
    lines.push('  else')
    lines.push('    echo "❌ yt-dlp not found. Install it (pip install yt-dlp) or provide INPUT=path/to/video.mp4" >&2')
    lines.push(`    echo "   Source video: ${youtubeUrl}" >&2`)
    lines.push('    exit 1')
    lines.push('  fi')
    lines.push('else')
    lines.push('  CLEANUP_SOURCE=0')
    lines.push('fi')
  } else {
    lines.push('INPUT="${INPUT:?Provide INPUT=path/to/video.mp4}"')
  }
  lines.push('')
  lines.push('if [ ! -f "$INPUT" ]; then')
  lines.push('  echo "❌ Input file not found: $INPUT" >&2')
  lines.push('  exit 1')
  lines.push('fi')
  lines.push('')
  lines.push('# 1. Write the .ass subtitle file (OUTPUT-TIME, cuts already accounted for)')
  lines.push('cat > "$ASS" <<\'ASSEOF\'')
  lines.push(generateASS(recipe))
  lines.push('ASSEOF')
  lines.push('')

  lines.push('# 2. Extract keep segments (between cuts)')
  keepRanges.forEach((r, i) => {
    lines.push(
      `ffmpeg -nostdin -y -ss ${timeToFFmpeg(r.start)} -to ${timeToFFmpeg(r.end)} -i "$INPUT" -c copy -avoid_negative_ts make_zero part_${i}.mp4`,
    )
  })
  lines.push('')

  lines.push('# 3. Concatenate the keep segments')
  lines.push('printf "" > concat.txt')
  keepRanges.forEach((_, i) => {
    lines.push(`echo "file 'part_${i}.mp4'" >> concat.txt`)
  })
  lines.push('ffmpeg -nostdin -y -f concat -safe 0 -i concat.txt -c copy merged.mp4')
  lines.push('')

  lines.push('# 4. Camera punch-in (9:16 crop FIRST, then fps=30 normalization so zoompan',
  'never stretches non-30fps sources, then zoompan), then burn subtitles last (fixed size)')
  const zoomFilter = buildZoompanFilter(recipe)
  const vfParts: string[] = ['scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920']
  if (zoomFilter) {
    // same duration contract as the mini-service renderer: zoompan re-stamps
    // every frame at its fps=30, so a 60fps input would double the output
    // duration without this normalization (see renderer postParts comment)
    vfParts.push('fps=30', zoomFilter)
  }
  vfParts.push(`ass='$ASS'`)
  lines.push(`ffmpeg -nostdin -y -i merged.mp4 -vf "${vfParts.join(',')}" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 128k "$OUTPUT"`)
  lines.push('')
  lines.push('# 5. Cleanup intermediate files')
  lines.push(`rm -f part_*.mp4 concat.txt merged.mp4 "$ASS"`)
  if (youtubeUrl) {
    lines.push('if [ "$CLEANUP_SOURCE" = "1" ]; then rm -f "$INPUT"; fi')
  }
  lines.push('')
  lines.push('echo "✅ Rendered: $OUTPUT"')

  return lines.join('\n')
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)
}

// Build a JSON "render recipe" that the renderer mini-service executes.
// camera_keyframes are pre-mapped to OUTPUT time (the mini-service works in output time).
// options.coverTimestamp — optional OUTPUT-time second for the Short's cover
// frame; the renderer extracts a JPG from the RENDERED output at that exact
// time (the same frame the UI previews via the keep-range mapping).
// options.quality — optional render preset (default 'standard').
export function buildRecipeJSON(
  recipe: RenderRecipe,
  options: { coverTimestamp?: number | null; quality?: RenderQuality } = {},
): string {
  const keep = buildKeepRanges(recipe.clipStart, recipe.clipEnd, recipe.cuts)
  // pre-map camera keyframes to output time for the renderer
  const cameraKeyframesOutput = recipe.cameraKeyframes
    .map((kf) => ({ time: Math.max(0, sourceToOutputTime(kf.time, recipe.clipStart, recipe.cuts)), scale: kf.scale }))
    .sort((a, b) => a.time - b.time)
  const outDur = outputDuration(recipe)
  // cover: emit ONLY when a finite, in-bounds timestamp was chosen — the
  // renderer validates independently, but we never send known-bad data
  const ct = options.coverTimestamp
  const cover =
    typeof ct === 'number' && isFinite(ct) && ct >= 0 && ct <= outDur + 1.0
      ? { timestamp: Math.min(ct, Math.max(0, outDur - 0.05)) }
      : undefined
  return JSON.stringify(
    {
      source: { youtube_id: recipe.youtubeId, clip_start: recipe.clipStart, clip_end: recipe.clipEnd },
      keep_ranges: keep,
      output_duration: outDur,
      cuts: recipe.cuts,
      subtitles_ass: generateASS(recipe),
      camera_keyframes: cameraKeyframesOutput,
      sound_effects: recipe.soundEffects,
      music: recipe.music,
      segments: recipe.segments,
      cover,
      quality: options.quality ?? 'standard',
      title: recipe.title,
      duration: outDur,
    },
    null,
    2,
  )
}

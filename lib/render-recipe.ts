// Render recipe: convert an AI edit plan into concrete render instructions
// (used by the in-browser AutoEditPlayer AND the ffmpeg shell-script generator)

import type { EditPlan } from '@/lib/editplan'

export interface RenderRecipe {
  clipId: string
  clipStart: number
  clipEnd: number
  duration: number
  youtubeId: string
  // cuts as "skip ranges" (absolute seconds in source video)
  cuts: { start: number; end: number; reason: string }[]
  // camera scale as function of time -> scale (linear interpolation)
  cameraKeyframes: { time: number; scale: number }[]
  // subtitles with absolute source timestamps
  subtitles: {
    start: number
    end: number
    text: string
    emphasis_words: string[]
    emphasis_type?: string
  }[]
  // segment markers (absolute source timestamps)
  segments: { type: string; start: number; end: number; purpose: string }[]
  // visuals (overlays) with absolute source timestamps
  visuals: {
    type: string
    start: number
    end: number
    purpose: string
    prompt: string
    aspect_ratio: string
  }[]
  // sound effects with absolute source timestamps
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
    cameraKeyframes: sc.camera.map((c) => ({ time: c.start, scale: c.scale_start })).concat(
      sc.camera.map((c) => ({ time: c.end, scale: c.scale_end })),
    ),
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

// Get current camera scale at a given absolute source time (linear interp)
export function scaleAtTime(time: number, keyframes: { time: number; scale: number }[]): number {
  if (keyframes.length === 0) return 1
  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  // find surrounding keyframes
  let prev = sorted[0]
  let next = sorted[sorted.length - 1]
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].time <= time && sorted[i + 1].time >= time) {
      prev = sorted[i]
      next = sorted[i + 1]
      break
    }
  }
  if (time <= sorted[0].time) return sorted[0].scale
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].scale
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

// Get the current active subtitle at a time
export function subtitleAtTime(
  time: number,
  subs: { start: number; end: number; text: string; emphasis_words: string[]; emphasis_type?: string }[],
) {
  return subs.find((s) => time >= s.start && time < s.end) ?? null
}

// Get the current segment at a time
export function segmentAtTime(
  time: number,
  segs: { type: string; start: number; end: number }[],
) {
  return segs.find((s) => time >= s.start && time < s.end) ?? null
}

// Get active visual at a time
export function visualAtTime(
  time: number,
  visuals: { start: number; end: number; type: string; purpose: string }[],
) {
  return visuals.find((v) => time >= v.start && time < v.end) ?? null
}

// Synthesize a sound effect via Web Audio API
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
    // white noise burst
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

// ---- ffmpeg shell script generation ----

export function timeToFFmpeg(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${pad(h)}:${pad(m)}:${pad(si)}.${pad(ms, 3)}`
}

// Generate an .ass subtitle file with emphasis styling
export function generateASS(
  recipe: RenderRecipe,
  options: { fontSize?: number; primaryColor?: string; outlineColor?: string } = {},
): string {
  const fs = options.fontSize ?? 48
  const primary = options.primaryColor ?? '&H00E8E8E8' // white-ish (ASS BGR order, &HAABBGGRR)
  const outline = options.outlineColor ?? '&H00000000' // black
  const header = `[Script Info]
Script Type: V4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,${fs},${primary},&H000000FF,${outline},&H64000000,1,0,0,0,100,100,0,0,1,3,2,2,80,80,120,1
Style: Emphasis,Inter,${fs},&H0000E8FF,&H000000FF,${outline},&H64000000,1,1,0,0,100,100,0,0,1,3,2,2,80,80,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events = recipe.subtitles
    .map((s) => {
      const text = applyASSEmphasis(s.text, s.emphasis_words, s.emphasis_type)
      return `Dialogue: 0,${timeToFFmpeg(s.start - recipe.clipStart)},${timeToFFmpeg(s.end - recipe.clipStart)},Default,,0,0,0,,${text}`
    })
    .join('\n')
  // hook overlay as a title card at clip start
  const hookLines = recipe.generatedHook
    ? `Dialogue: 1,0:00:00.000,0:00:03.000,Emphasis,,0,0,0,,${escapeASS(recipe.generatedHook)}\n`
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
    if (type === 'uppercase') prefix = '{\\fs' + (Math.round(48 * 1.2)) + '}'
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

// Generate a complete ffmpeg shell script that performs the edit
export function generateFFmpegScript(
  recipe: RenderRecipe,
  options: { inputVar?: string; outputFile?: string; youtubeUrl?: string } = {},
): string {
  const output = options.outputFile ?? `clipforge_${sanitize(recipe.title)}.mp4`
  const assPath = `clipforge_${sanitize(recipe.title)}.ass`
  const youtubeUrl = options.youtubeUrl

  // Build segments between cuts (the "keep" ranges)
  const keepRanges: { start: number; end: number }[] = []
  const sortedCuts = [...recipe.cuts].sort((a, b) => a.start - b.start)
  let cursor = recipe.clipStart
  for (const cut of sortedCuts) {
    if (cut.start > cursor) keepRanges.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (cursor < recipe.clipEnd) keepRanges.push({ start: cursor, end: recipe.clipEnd })
  if (keepRanges.length === 0) keepRanges.push({ start: recipe.clipStart, end: recipe.clipEnd })

  const lines: string[] = []
  lines.push('#!/bin/bash')
  lines.push('# ClipForge AI — Auto-Edit Render Script')
  lines.push(`# Clip: "${recipe.title}"`)
  lines.push(`# Source range: ${timeToFFmpeg(recipe.clipStart)} -> ${timeToFFmpeg(recipe.clipEnd)} (${recipe.duration.toFixed(1)}s)`)
  lines.push(`# Cuts: ${recipe.cuts.length} | Subtitles: ${recipe.subtitles.length} | Camera moves: ${recipe.cameraKeyframes.length / 2}`)
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

  // INPUT resolution: yt-dlp auto-download OR local file
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
    lines.push('    INPUT="source.mp4"')
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
  lines.push('# 1. Write the .ass subtitle file')
  lines.push('cat > "$ASS" <<\'ASSEOF\'')
  lines.push(generateASS(recipe))
  lines.push('ASSEOF')
  lines.push('')

  // Extract each keep segment
  lines.push('# 2. Extract keep segments (between cuts)')
  keepRanges.forEach((r, i) => {
    lines.push(
      `ffmpeg -nostdin -y -ss ${timeToFFmpeg(r.start)} -to ${timeToFFmpeg(r.end)} -i "$INPUT" -c copy -avoid_negative_ts make_zero part_${i}.mp4`,
    )
  })
  lines.push('')

  // Build concat list
  lines.push('# 3. Concatenate the keep segments')
  lines.push('printf "" > concat.txt')
  keepRanges.forEach((_, i) => {
    lines.push(`echo "file 'part_${i}.mp4'" >> concat.txt`)
  })
  lines.push('ffmpeg -nostdin -y -f concat -safe 0 -i concat.txt -c copy merged.mp4')
  lines.push('')

  // Apply subtitles + camera zoom (re-encode)
  lines.push('# 4. Burn subtitles + apply camera punch-in via zoompan')
  const zoomFilter = buildZoompanFilter(recipe)
  const vfParts = [`ass='$ASS'`]
  if (zoomFilter) vfParts.push(zoomFilter)
  vfParts.push(`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`)
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

// Build ffmpeg zoompan filter from camera keyframes (best-effort interpolation)
function buildZoompanFilter(recipe: RenderRecipe): string | null {
  const kfs = recipe.cameraKeyframes
  if (!kfs || kfs.length < 2) return null
  // Build a series of zoompan expressions — one per frame, interpolated
  // Simplified: use zpan with a time-based expression
  // frame rate assumed 30fps
  const fps = 30
  const totalFrames = Math.max(1, Math.round(recipe.duration * fps))
  const sortedKfs = [...kfs].sort((a, b) => a.time - b.time)
  // pre-compute scale per second
  const scalesPerSecond: number[] = []
  for (let f = 0; f < totalFrames; f++) {
    const t = recipe.clipStart + (f / fps)
    scalesPerSecond.push(scaleAtTime(t, sortedKfs))
  }
  // zoompan accepts z=expression per frame, frames per image = totalFrames
  // Use a precomputed lookup via a long if-else expression — fallback: average
  const maxScale = Math.max(...scalesPerSecond, 1)
  const minScale = Math.min(...scalesPerSecond, 1)
  if (Math.abs(maxScale - minScale) < 0.01) return null // no movement
  // Simple: linear ramp from min to max and back, anchored at keyframe times
  // Build expression using 'on' (frame index) and conditional logic
  // For robustness, just use a stepwise expression
  let expr = `${scalesPerSecond[0].toFixed(3)}`
  // Build piecewise — actually ffmpeg zoompan 'z' is evaluated per output frame; can be expression using on (frame number)
  // Use a polynomial approximation via lookup table expression
  // Practical fallback: use z='if(lt(on,N1),S1,if(lt(on,N2),S2,...))'
  // This generates a long expression but works
  const samples: { frame: number; scale: number }[] = []
  const step = Math.max(1, Math.floor(totalFrames / 20)) // sample 20 points max
  for (let f = 0; f < totalFrames; f += step) {
    samples.push({ frame: f, scale: scalesPerSecond[f] })
  }
  samples.push({ frame: totalFrames, scale: scalesPerSecond[totalFrames - 1] })
  expr = samples
    .map((s, i) => (i === 0 ? `${s.scale.toFixed(3)}` : `if(lt(on,${s.frame}),${s.scale.toFixed(3)},NEXT)`))
    .reverse()
    .reduce((acc, cur) => acc.replace('NEXT', cur), samples[samples.length - 1].scale.toFixed(3))
  // zoompan filter: needs d (duration per frame), s (output size)
  return `zoompan=z='${expr}':d=1:s=1080x1920:fps=${fps}`
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)
}

// Build a JSON "render recipe" that a future renderer (or the mini-service) can execute
export function buildRecipeJSON(recipe: RenderRecipe): string {
  return JSON.stringify(
    {
      source: { youtube_id: recipe.youtubeId, clip_start: recipe.clipStart, clip_end: recipe.clipEnd },
      keep_ranges: getKeepRanges(recipe),
      subtitles_ass: generateASS(recipe),
      camera_keyframes: recipe.cameraKeyframes,
      sound_effects: recipe.soundEffects,
      music: recipe.music,
      segments: recipe.segments,
      title: recipe.title,
      duration: recipe.duration,
    },
    null,
    2,
  )
}

function getKeepRanges(recipe: RenderRecipe): { start: number; end: number }[] {
  const sortedCuts = [...recipe.cuts].sort((a, b) => a.start - b.start)
  let cursor = recipe.clipStart
  const ranges: { start: number; end: number }[] = []
  for (const cut of sortedCuts) {
    if (cut.start > cursor) ranges.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (cursor < recipe.clipEnd) ranges.push({ start: cursor, end: recipe.clipEnd })
  if (ranges.length === 0) ranges.push({ start: recipe.clipStart, end: recipe.clipEnd })
  return ranges
}

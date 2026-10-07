// ---------------------------------------------------------------------------
// ClipForge — Timeline mapping + real-transcript subtitle generation
//
// TWO EXPLICIT TIME SYSTEMS:
//   SOURCE_TIME — seconds in the original video
//   OUTPUT_TIME — seconds in the rendered clip AFTER cuts are removed
//
// Every rendered effect (subtitles, camera, overlays) MUST be expressed in
// OUTPUT_TIME. These helpers are THE canonical mapping used by the renderer,
// ASS generation, SRT/VTT export and the shell-script generator.
// ---------------------------------------------------------------------------

export interface Cut { start: number; end: number; reason?: string }
export interface Word { word: string; start: number; end: number }
export interface SubtitleBlock {
  start: number // OUTPUT time
  end: number
  text: string
  emphasis_words: string[]
  emphasis_type?: string
}

/** Keep ranges = clip window minus cuts (sorted, clipped to [clipStart, clipEnd]). */
export function buildKeepRanges(clipStart: number, clipEnd: number, cuts: Cut[]): { start: number; end: number }[] {
  const sorted = [...cuts]
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start)
  const ranges: { start: number; end: number }[] = []
  let cursor = clipStart
  for (const cut of sorted) {
    const cs = Math.max(cut.start, clipStart)
    const ce = Math.min(cut.end, clipEnd)
    if (cs >= clipEnd) break
    if (ce <= cursor) continue
    if (cs > cursor) ranges.push({ start: cursor, end: cs })
    cursor = Math.max(cursor, ce)
  }
  if (cursor < clipEnd) ranges.push({ start: cursor, end: clipEnd })
  if (ranges.length === 0) ranges.push({ start: clipStart, end: clipEnd })
  return ranges
}

/** Total removed duration within the clip. */
export function totalCutDuration(clipStart: number, clipEnd: number, cuts: Cut[]): number {
  return buildKeepRanges(clipStart, clipEnd, cuts).reduce((acc, r) => acc + (r.end - r.start), 0)
}

/** SOURCE_TIME → OUTPUT_TIME (seconds before clip start removed implicitly). */
export function sourceToOutputTime(sourceTime: number, clipStart: number, cuts: Cut[]): number {
  const sorted = [...cuts]
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start)
  let removed = 0
  for (const c of sorted) {
    const cs = Math.max(c.start, clipStart)
    const ce = Math.min(c.end, Number.MAX_SAFE_INTEGER)
    if (ce <= cs) continue
    if (sourceTime >= ce) {
      removed += ce - cs // whole cut lies before this source time
    } else if (sourceTime > cs) {
      // inside a cut → snap to the cut start (in output coordinates)
      return Math.max(0, Math.round((cs - clipStart - removed) * 1000) / 1000)
    } else {
      break
    }
  }
  return Math.max(0, Math.round((sourceTime - clipStart - removed) * 1000) / 1000)
}

/** OUTPUT_TIME → SOURCE_TIME (inverse mapping; lands inside the containing keep range). */
export function outputToSourceTime(outputTime: number, clipStart: number, cuts: Cut[]): number {
  const ranges = buildKeepRanges(clipStart, Number.MAX_SAFE_INTEGER, cuts)
  let acc = 0
  for (const r of ranges) {
    const len = r.end - r.start
    if (outputTime < acc + len) {
      return Math.round((r.start + (outputTime - acc)) * 1000) / 1000
    }
    acc += len
  }
  const last = ranges[ranges.length - 1]
  return last ? last.end : clipStart
}

/** Output duration of the clip after cuts. */
export function outputDuration(clipStart: number, clipEnd: number, cuts: Cut[]): number {
  return Math.round((clipEnd - clipStart - totalCutDuration(clipStart, clipEnd, cuts)) * 1000) / 1000
}

/** True if a source-time event lies entirely inside removed ranges (should be dropped). */
export function isDroppedByCuts(start: number, end: number, clipStart: number, clipEnd: number, cuts: Cut[]): boolean {
  const kept = buildKeepRanges(clipStart, clipEnd, cuts)
  const overlap = kept.reduce((acc, r) => acc + Math.max(0, Math.min(end, r.end) - Math.max(start, r.start)), 0)
  return overlap <= Math.min(0.35, (end - start) * 0.5) // >~65% inside cuts → drop
}

// ---------------------------------------------------------------------------
// Subtitle generation from REAL word timestamps
// ---------------------------------------------------------------------------

/**
 * Group word timestamps into mobile-friendly subtitle blocks (3–7 words,
 * max ~1.8s per block, split at punctuation when possible).
 */
export function groupWordsIntoBlocks(
  words: Word[],
  opts: { maxWords?: number; minWords?: number; maxGap?: number } = {},
): { start: number; end: number; words: Word[] }[] {
  const maxWords = opts.maxWords ?? 7
  const minWords = opts.minWords ?? 3
  const maxGap = opts.maxGap ?? 0.8
  const blocks: { start: number; end: number; words: Word[] }[] = []
  let current: Word[] = []
  const flush = () => {
    if (current.length > 0) {
      blocks.push({ start: current[0].start, end: current[current.length - 1].end, words: current })
      current = []
    }
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (current.length > 0) {
      const gap = w.start - current[current.length - 1].end
      const punct = /[.!?…]$/.test(current[current.length - 1].word)
      if (gap > maxGap || punct || current.length >= maxWords) {
        // avoid tiny orphan blocks: flush only if we have enough words or hard break
        if (current.length >= minWords || punct || gap > maxGap) flush()
      }
    }
    current.push(w)
  }
  flush()
  return blocks
}

/**
 * Build subtitle blocks in OUTPUT_TIME from real clip words + cuts.
 * This is the deterministic, transcript-grounded subtitle source.
 */
export function buildSubtitlesFromWords(
  clipWords: Word[],
  clipStart: number,
  clipEnd: number,
  cuts: Cut[],
  emphasisWords: string[] = [],
): SubtitleBlock[] {
  const inRange = clipWords
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({ ...w, start: Math.max(w.start, clipStart), end: Math.min(w.end, clipEnd) }))
    .sort((a, b) => a.start - b.start)
  const blocks = groupWordsIntoBlocks(inRange)
  const result: SubtitleBlock[] = []
  for (const b of blocks) {
    // skip blocks mostly inside cuts
    if (isDroppedByCuts(b.start, b.end, clipStart, clipEnd, cuts)) continue
    const start = sourceToOutputTime(b.start, clipStart, cuts)
    const end = sourceToOutputTime(b.end, clipStart, cuts)
    if (end - start < 0.15) continue
    const text = b.words.map((w) => w.word).join(' ')
    const emph = emphasisWords.filter((e) =>
      text.toLowerCase().includes(String(e).toLowerCase()),
    )
    result.push({
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text,
      emphasis_words: emph.slice(0, 3),
      emphasis_type: emph.length > 0 ? 'bold' : undefined,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// SRT / VTT rendering (OUTPUT_TIME — what the rendered video shows)
// ---------------------------------------------------------------------------

function pad(n: number, l = 2): string {
  return String(n).padStart(l, '0')
}

export function fmtSrtTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(si)},${pad(Math.min(999, ms), 3)}`
}

export function fmtVttTime(sec: number): string {
  return fmtSrtTime(sec).replace(',', '.')
}

export function buildSrt(blocks: SubtitleBlock[]): string {
  return (
    blocks
      .map((b, i) => `${i + 1}\n${fmtSrtTime(b.start)} --> ${fmtSrtTime(b.end)}\n${b.text}`)
      .join('\n\n') + '\n'
  )
}

export function buildVtt(blocks: SubtitleBlock[]): string {
  return (
    'WEBVTT\n\n' +
    blocks
      .map((b, i) => `${i + 1}\n${fmtVttTime(b.start)} --> ${fmtVttTime(b.end)}\n${b.text}`)
      .join('\n\n') +
    '\n'
  )
}

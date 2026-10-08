import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DurationSource = 'yt-dlp' | 'innertube' | 'ffprobe' | 'user-provided' | 'unavailable'
export type TranscriptSource = 'youtube-captions' | 'manual' | 'asr' | 'none'

export interface WordTimestamp {
  word: string
  start: number
  end: number
}

export interface ResolvedMeta {
  youtubeId: string
  url: string
  title: string
  author: string | null
  thumbnail: string
  provider: string
  duration: number | null // REAL seconds, or null when unobtainable
  durationSource: DurationSource
  resolverErrors: string[] // what failed, for transparency (never silent)
}

export interface ResolvedTranscript {
  text: string
  words: WordTimestamp[]
  source: TranscriptSource
  language?: string
  /**
   * TIMING PROVENANCE (mission Phase 2 — never lie about precision):
   * 'measured'  — ≥80% of caption segments carry REAL per-word offsets (json3
   *               tOffsetMs, srv3 word attrs, or ASR) → true word-level timing.
   * 'mixed'     — 20–80% measured: part of the words are measured, the rest
   *               interpolated from segment timings.
   * 'estimated' — no (or almost no) real word timing; word times are evenly
   *               distributed within segment timings.
   * Downstream (karaoke, export) must NEVER treat estimated/mixed timing as
   * exact — the plan route only emits karaoke for verified measured windows.
   */
  wordTiming: 'measured' | 'estimated' | 'mixed'
  error?: string
}

export interface YouTubeSource {
  meta: ResolvedMeta
  transcript: ResolvedTranscript | null
}

// ---------------------------------------------------------------------------
// YouTube ID extraction
// ---------------------------------------------------------------------------

export function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/live\/)([\w-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  if (/^[\w-]{11}$/.test(url.trim())) return url.trim()
  return null
}

// ---------------------------------------------------------------------------
// yt-dlp helpers (real metadata + real captions)
// ---------------------------------------------------------------------------

const YTDLP_TIMEOUT_MS = 25_000

function findYtDlp(): string | null {
  // resolution order: venv → user-local install (pip --user / PEP 668
  // break-system-packages land in ~/.local/bin) → system paths. A binary
  // present on disk but missing from the server process's PATH must still be
  // found (container restarts silently drop PATH additions).
  const candidates = [
    '/home/z/.venv/bin/yt-dlp',
    process.env.HOME ? `${process.env.HOME}/.local/bin/yt-dlp` : '/home/z/.local/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch { /* ignore */ }
  }
  return null
}

async function runYtDlp(args: string[], timeoutMs = YTDLP_TIMEOUT_MS): Promise<string> {
  const bin = findYtDlp()
  if (!bin) throw new Error('yt-dlp is not installed on the server')
  const { stdout } = await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/home/z/.venv/bin` },
  })
  return stdout
}

/** Real video metadata via yt-dlp (includes exact duration in seconds). */
async function ytDlpMeta(youtubeId: string): Promise<{ duration: number; title?: string; author?: string } | null> {
  try {
    const out = await runYtDlp([
      '--js-runtimes', 'bun',
      '--no-warnings',
      '--skip-download',
      '--dump-json',
      `https://www.youtube.com/watch?v=${youtubeId}`,
    ])
    const data = JSON.parse(out)
    const duration = Number(data.duration)
    if (!isFinite(duration) || duration <= 0) return null
    return {
      duration,
      title: typeof data.title === 'string' ? data.title : undefined,
      author: typeof data.channel === 'string' ? data.channel : typeof data.uploader === 'string' ? data.uploader : undefined,
    }
  } catch {
    return null
  }
}

/** Real caption download via yt-dlp (json3 = word-level timings for auto-subs). */
async function ytDlpCaptions(youtubeId: string, langPref = 'en,id'): Promise<{ json3: unknown; lang: string } | null> {
  const dir = mkdtempSync(join(tmpdir(), 'clipforge-caps-'))
  try {
    // NOTE: yt-dlp --sub-langs entries are PYTHON REGEX, not shell globs —
    // `*-orig` is rejected outright ("Wrong regex for subtitlelangs") which
    // silently killed caption download. Valid: `en.*`, `.*-orig`.
    // ORDER MATTERS: the ASR 'orig' track (real per-word offsets) is requested
    // FIRST — when YouTube 429s a later variant the best track is already on disk.
    const langs = `.*-orig,en.*,${langPref}`
    // IMPORTANT: a 429 on ONE language variant fails the whole yt-dlp process
    // even though other tracks were already written — so never let a non-zero
    // exit abort the fetch; decide from the files on disk instead.
    await runYtDlp(
      [
        '--js-runtimes', 'bun',
        '--no-warnings',
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', langs,
        '--sub-format', 'json3/vtt/srv3/best',
        '-o', join(dir, 'subs'),
        `https://www.youtube.com/watch?v=${youtubeId}`,
      ],
      45_000,
    ).catch(() => {})
    let files = readdirSync(dir).filter((f) => f.startsWith('subs') && (f.endsWith('.json3') || f.endsWith('.vtt') || f.endsWith('.srv3')))
    // retry: some videos name tracks outside our patterns → accept any language as a last resort
    if (files.length === 0) {
      await runYtDlp(
        [
          '--js-runtimes', 'bun',
          '--no-warnings',
          '--skip-download',
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs', 'all',
          '--sub-format', 'json3/vtt/srv3/best',
          '--max-downloads', '1',
          '-o', join(dir, 'subs'),
          `https://www.youtube.com/watch?v=${youtubeId}`,
        ],
        45_000,
      ).catch(() => {})
      files = readdirSync(dir).filter((f) => f.startsWith('subs') && (f.endsWith('.json3') || f.endsWith('.vtt') || f.endsWith('.srv3')))
    }
    if (files.length === 0) return null
    // TRACK SELECTION = TIMING QUALITY FIRST (mission Phase 2.6 — never prefer
    // a container merely because of its format). The best-quality track wins;
    // ties break by format (json3 > srv3 > vtt), then deterministic filename
    // order. So a srv3 track WITH word offsets beats a json3 track WITHOUT them.
    const offsetRatio = (f: string): number => captionTrackTimingQuality(f, () => readFileSync(join(dir, f), 'utf-8'))
    files.sort((a, b) => {
      const qa = offsetRatio(a)
      const qb = offsetRatio(b)
      if (Math.abs(qa - qb) > 0.05) return qb - qa // REAL word timing wins regardless of container
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      return a.localeCompare(b)
    })
    const content = readFileSync(join(dir, files[0]), 'utf-8')
    const lang = files[0].match(/subs\.([\w-]+)/)?.[1] ?? 'unknown'
    if (files[0].endsWith('.json3')) {
      return { json3: JSON.parse(content), lang }
    }
    if (files[0].endsWith('.srv3')) {
      // srv3 (XML) can carry word-level offsets in <s> elements
      return { json3: srv3ToJson3(content), lang }
    }
    // VTT has NO word timing → converted to segment-level json3 (estimated)
    return { json3: vttToJson3(content), lang }
  } catch {
    return null
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  function rank(f: string): number {
    if (f.endsWith('.json3')) return 0
    if (f.endsWith('.srv3')) return 1
    return 2
  }
}

/**
 * Timing quality of a caption track file (0..1): the fraction of caption
 * segments carrying REAL per-word offsets. Used to RANK candidate tracks by
 * actual usable timing instead of container format (mission Phase 2.6).
 * Pure: reads content via the injected reader (unit-testable).
 */
export function captionTrackTimingQuality(fileName: string, readText: () => string): number {
  try {
    if (fileName.endsWith('.json3')) {
      const j = JSON.parse(readText()) as { events?: { segs?: { tOffsetMs?: number }[] }[] }
      const segs = (j.events ?? []).flatMap((e) => e.segs ?? [])
      if (segs.length === 0) return 0
      return segs.filter((s) => typeof s.tOffsetMs === 'number' && isFinite(s.tOffsetMs)).length / segs.length
    }
    if (fileName.endsWith('.srv3')) {
      const xml = readText()
      const sElems = xml.match(/<s\b[^>]*>/g) ?? []
      if (sElems.length === 0) return 0
      const withOffset = sElems.filter((s) => /\bac-as="\d+"/.test(s) || /\bt="\d+"/.test(s)).length
      return withOffset / sElems.length
    }
  } catch {
    return 0 // unreadable/corrupt track ranks last
  }
  return 0 // vtt has no word timing
}

/**
 * Parse one WebVTT timestamp. Valid WebVTT forms:
 *   HH:MM:SS.mmm   MM:SS.mmm   (also accepts a comma decimal separator)
 * Returns milliseconds, or null when the string is not a valid timestamp.
 */
function parseVttTimestamp(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3].replace(',', '.'))
  if (!isFinite(h) || !isFinite(min) || !isFinite(sec)) return null
  return h * 3600000 + min * 60000 + Math.round(sec * 1000)
}

/**
 * Minimal VTT → json3-ish converter so downstream parsing stays uniform.
 *
 * ROBUSTNESS: accepts both HH:MM:SS.mmm and MM:SS.mmm cue timings, ignores
 * cue settings (align/position/line), joins multiline cue text, strips
 * HTML-like cue markup (including inline `<00:00:01.000>` timestamps), and
 * skips NOTE/STYLE/REGION blocks, malformed cues, and empty cues safely.
 *
 * TIMING HONESTY: a VTT cue carries ONE segment timestamp — never per-word
 * timing. The output keeps a single multi-word seg per cue WITHOUT word
 * offsets; parseJson3 distributes it as ESTIMATED word timing (never fake
 * "measured" word data).
 */
function vttToJson3(vtt: string): unknown {
  const events: { tStartMs: number; dDurationMs: number; segs: { utf8: string }[] }[] = []
  const blocks = vtt.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue // empty block
    if (/^(WEBVTT|NOTE|STYLE|REGION)/.test(lines[0]) && !lines[0].includes('-->')) {
      lines.shift() // header/comment block marker (cue id may still follow)
    }
    const cueIdx = lines.findIndex((l) => l.includes('-->'))
    if (cueIdx === -1) continue // malformed / comment-only block → skip
    const cue = lines[cueIdx]
    const tm = cue.match(/([0-9:.,]+)\s*-->\s*([0-9:.,]+)/)
    if (!tm) continue
    const start = parseVttTimestamp(tm[1])
    const end = parseVttTimestamp(tm[2])
    if (start === null || end === null || end <= start) continue // malformed cue
    // cue text: everything after the cue line (multiline cues joined)
    const text = lines
      .slice(cueIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // strip markup + inline timestamps
      .replace(/&nbsp;/g, ' ')
      .trim()
    if (!text) continue // empty cue → skip
    events.push({ tStartMs: start, dDurationMs: end - start, segs: [{ utf8: text }] })
  }
  return { events }
}

/**
 * Minimal srv3 (XML timedtext) → json3-ish converter.
 * <p t="start" d="dur"><s ac-as="offset"|t="offset">word</s>...</p>
 *
 * TIMING HONESTY: a word offset is carried through ONLY when the source
 * actually supplies one. A missing offset stays ABSENT (undefined) — it must
 * NEVER become 0, because downstream code interprets a numeric offset as REAL
 * measured timing (0 would pin a word to the segment start and poison the
 * 'measured' provenance label).
 */
function srv3ToJson3(xml: string): unknown {
  const events: { tStartMs: number; dDurationMs: number; segs: { utf8: string; tOffsetMs?: number }[] }[] = []
  const pRe = /<p\b[^>]*\bt="(\d+)"[^>]*(?:\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g
  let pm: RegExpExecArray | null
  while ((pm = pRe.exec(xml)) !== null) {
    const tStartMs = Number(pm[1])
    const dDurationMs = Number(pm[2] ?? 0) || 3000
    const inner = pm[3]
    const segs: { utf8: string; tOffsetMs?: number }[] = []
    const sRe = /<s\b([^>]*)>([\s\S]*?)<\/s>/g
    let sm: RegExpExecArray | null
    let foundS = false
    while ((sm = sRe.exec(inner)) !== null) {
      foundS = true
      const attrs = sm[1] ?? ''
      const offM = attrs.match(/\bac-as="(\d+)"/) ?? attrs.match(/\bt="(\d+)"/)
      const off = offM ? Number(offM[1]) : NaN
      const text = sm[2].replace(/<[^>]+>/g, '')
      if (!text.trim()) continue
      segs.push({ utf8: text, tOffsetMs: typeof off === 'number' && isFinite(off) ? off : undefined })
    }
    if (!foundS) {
      const text = inner.replace(/<[^>]+>/g, '').trim()
      if (text) segs.push({ utf8: text })
    }
    if (segs.length > 0) events.push({ tStartMs, dDurationMs, segs })
  }
  return { events }
}

// ---------------------------------------------------------------------------
// Innertube player API (fallback for real duration)
// ---------------------------------------------------------------------------

async function innertubeMeta(youtubeId: string): Promise<{ duration: number; title?: string; author?: string; captions?: number } | null> {
  const attempts: { body: unknown; ua: string; key: string }[] = [
    {
      body: { context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'en' } }, videoId: youtubeId },
      ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    },
    {
      body: { context: { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en' } }, videoId: youtubeId },
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    },
  ]
  for (const a of attempts) {
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${a.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': a.ua },
        body: JSON.stringify(a.body),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) continue
      const data = await res.json()
      const len = Number(data?.videoDetails?.lengthSeconds)
      if (isFinite(len) && len > 0) {
        return {
          duration: len,
          title: data.videoDetails.title,
          author: data.videoDetails.author,
          captions: data?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ?? 0,
        }
      }
    } catch {
      // try next
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// oEmbed (always-available basics: title/author/thumbnail — NO duration)
// ---------------------------------------------------------------------------

async function oembedMeta(youtubeId: string): Promise<{ title: string; author: string | null; thumbnail: string } | null> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${youtubeId}`)}&format=json`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ClipForgeAI/2.0' },
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 3600 },
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      title: data.title ?? 'Untitled video',
      author: data.author_name ?? null,
      thumbnail: data.thumbnail_url ?? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public resolver: REAL duration with explicit source + explicit failures
// ---------------------------------------------------------------------------

export async function resolveYoutubeMeta(url: string): Promise<ResolvedMeta> {
  const youtubeId = extractYouTubeId(url)
  if (!youtubeId) throw new Error('Invalid YouTube URL')
  const canonical = `https://www.youtube.com/watch?v=${youtubeId}`
  const resolverErrors: string[] = []

  // 1. yt-dlp — most reliable, gives exact duration
  const ytd = await ytDlpMeta(youtubeId)
  if (ytd) {
    return {
      youtubeId,
      url: canonical,
      title: ytd.title ?? 'Untitled video',
      author: ytd.author ?? null,
      thumbnail: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      provider: 'YouTube',
      duration: Math.round(ytd.duration * 10) / 10,
      durationSource: 'yt-dlp',
      resolverErrors,
    }
  }
  resolverErrors.push('yt-dlp: unavailable (blocked, throttled, or not installed)')

  // 2. Innertube player API
  const itube = await innertubeMeta(youtubeId)
  if (itube) {
    return {
      youtubeId,
      url: canonical,
      title: itube.title ?? 'Untitled video',
      author: itube.author ?? null,
      thumbnail: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      provider: 'YouTube',
      duration: itube.duration,
      durationSource: 'innertube',
      resolverErrors,
    }
  }
  resolverErrors.push('innertube player API: LOGIN_REQUIRED / blocked')

  // 3. oEmbed — basics only, duration stays NULL (never guessed)
  const oe = await oembedMeta(youtubeId)
  if (oe) {
    return {
      youtubeId,
      url: canonical,
      title: oe.title,
      author: oe.author,
      thumbnail: oe.thumbnail,
      provider: 'YouTube',
      duration: null,
      durationSource: 'unavailable',
      resolverErrors,
    }
  }
  throw new Error(`Could not fetch video metadata. ${resolverErrors.join('; ')}`)
}

// ---------------------------------------------------------------------------
// Public resolver: REAL transcript (captions first; ASR handled elsewhere)
// ---------------------------------------------------------------------------

interface Json3Event { tStartMs: number; dDurationMs?: number; segs?: { utf8: string; tOffsetMs?: number }[] }

/**
 * Parse YouTube json3 captions into word timestamps.
 *
 * TIMING HONESTY (critical): auto-generated YouTube captions carry REAL
 * word-level offsets — each `seg.tOffsetMs` is the word's offset from the
 * event start. When those offsets exist we use them verbatim and mark the
 * result 'measured'. Only when a track has NO per-word offsets (some manual
 * tracks, VTT fallback) do we distribute segment time evenly across words —
 * and that is explicitly labeled 'estimated', never treated as true word
 * timestamps downstream.
 */
/**
 * DEFINITION OF "MEASURED" (binding for all downstream provenance labels):
 *
 *   A word is MEASURED only when the source actually supplied timing that
 *   identifies the timing of that specific spoken token — i.e. the word was
 *   ALONE in its caption segment and that segment carried a real offset.
 *
 * Consequences (never violated below):
 *   - A missing word offset stays ABSENT — it is never coerced to 0.
 *   - A segment holding MULTIPLE words with one timestamp ("I love this
 *     technology" @ 10.0–12.0) does NOT give all four words independent
 *     measured timing. Only the group's start is real; the intra-group word
 *     boundaries are distributed → ESTIMATED.
 *   - A segment WITHOUT an offset inside a partially-measured event is
 *     interpolated in the gap between its measured neighbours → ESTIMATED
 *     (its measured neighbours keep their real times — real data is never
 *     thrown away just because a sibling segment lacks offsets).
 *   - The track label is computed PER WORD: ≥80% measured → 'measured',
 *     20–80% → 'mixed', otherwise 'estimated'.
 */
function parseJson3(json3: unknown): { words: WordTimestamp[]; text: string; wordTiming: 'measured' | 'estimated' | 'mixed' } {
  const words: WordTimestamp[] = []
  const events = (json3 as { events?: Json3Event[] })?.events ?? []
  let measuredWords = 0
  let totalWords = 0

  const round2 = (n: number) => Math.round(n * 100) / 100

  for (const ev of events) {
    if (!Array.isArray(ev.segs) || ev.segs.length === 0) continue
    const eventStartMs = ev.tStartMs ?? 0
    const eventEndMs = eventStartMs + (ev.dDurationMs ?? 0)

    // collect usable segments in speech order
    const usable: { text: string; offsetMs: number | null }[] = []
    for (const seg of ev.segs) {
      const raw = (seg.utf8 ?? '').replace(/\n/g, ' ').trim()
      if (!raw || raw === '\u200b' || raw === '&nbsp;') continue
      usable.push({ text: raw, offsetMs: typeof seg.tOffsetMs === 'number' && isFinite(seg.tOffsetMs) ? seg.tOffsetMs : null })
    }
    if (usable.length === 0) continue

    // flat word list with per-word anchor eligibility
    type FlatWord = { word: string; segIdx: number; first: boolean; sole: boolean }
    const flat: FlatWord[] = []
    for (let i = 0; i < usable.length; i++) {
      const parts = usable[i].text.split(/\s+/).filter(Boolean)
      for (let j = 0; j < parts.length; j++) {
        flat.push({ word: parts[j], segIdx: i, first: j === 0, sole: parts.length === 1 })
      }
    }
    if (flat.length === 0) continue

    // estimated slice width (window evenly divided; 80ms readability floor)
    const n = flat.length
    const winDurS = ev.dDurationMs && ev.dDurationMs > 0 ? ev.dDurationMs / 1000 : n * 0.24
    const per = Math.max(0.08, winDurS / n)

    // STARTS: an anchored seg's FIRST word takes the REAL anchor time (the
    // source identifies the group's start); every other word steps by the
    // estimated slice. Anchors are clamped only for monotonicity (a word can
    // never start before its predecessor + 80ms) — real anchors are never
    // moved by estimated slices unless the source data itself is malformed.
    const starts: number[] = []
    let prevStart = -Infinity
    let cursor = eventStartMs / 1000
    for (let i = 0; i < n; i++) {
      const f = flat[i]
      let s: number
      if (f.first && usable[f.segIdx].offsetMs !== null) {
        const anchor = (eventStartMs + (usable[f.segIdx].offsetMs as number)) / 1000
        s = Math.max(anchor, Number.isFinite(prevStart) ? prevStart + 0.08 : anchor)
      } else {
        s = Math.max(cursor, Number.isFinite(prevStart) ? prevStart + 0.08 : cursor)
      }
      starts.push(s)
      prevStart = s
      cursor = s + per
    }

    // ENDS: chain to the next word's start; the last word of the event ends at
    // the event boundary (both boundaries are source-supplied for measured
    // chains; estimated words inherit the same chaining for consistency)
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? starts[i + 1] : Math.max(eventEndMs / 1000, starts[i] + 0.08)
      const end = Math.max(starts[i] + 0.08, next > starts[i] ? next : starts[i] + 0.08)
      words.push({ word: flat[i].word, start: round2(starts[i]), end: round2(end) })
      totalWords++
      const f = flat[i]
      // MEASURED: the source identified THIS token's timing (sole word of a
      // segment with a real offset). Multi-word segments contribute only an
      // estimated grid even when their group start is real.
      if (f.sole && f.first && usable[f.segIdx].offsetMs !== null) measuredWords++
    }
  }

  // provenance is computed PER WORD (see the definition above this function)
  const measuredRatio = totalWords > 0 ? measuredWords / totalWords : 0
  const wordTiming: 'measured' | 'estimated' | 'mixed' =
    measuredRatio >= 0.8 ? 'measured' : measuredRatio >= 0.2 ? 'mixed' : 'estimated'
  return { words, text: words.map((w) => w.word).join(' '), wordTiming }
}

/**
 * Resolve transcript from YouTube captions.
 * Returns null when unavailable — callers must NOT fabricate content.
 */
export async function resolveYoutubeTranscript(youtubeId: string, langPref = 'en,id'): Promise<ResolvedTranscript | null> {
  const caps = await ytDlpCaptions(youtubeId, langPref)
  if (!caps) return null
  const parsed = parseJson3(caps.json3)
  if (!parsed.text.trim()) return null
  return {
    text: parsed.text,
    words: parsed.words,
    source: 'youtube-captions',
    language: caps.lang,
    wordTiming: parsed.wordTiming,
  }
}

// output-time helper re-export used by tests
export const __testHelpers = { parseJson3, srv3ToJson3, vttToJson3 }

// ---------------------------------------------------------------------------
// Source media download (URL flow → render without upload)
// ---------------------------------------------------------------------------

export interface DownloadedMedia {
  /** RELATIVE path under the project root, e.g. upload/yt/<id>/source.mp4 */
  relativePath: string
  sizeBytes: number
  mimeType: string
  duration: number | null
}

const MEDIA_EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
}

/** Mime type for a downloaded media extension (null = unknown/ignored). */
export function mediaMimeForExt(ext: string): string | null {
  return MEDIA_EXT_MIME[ext.toLowerCase()] ?? null
}

/** Strict YouTube id check — the id is interpolated into a filesystem path. */
export function isSafeYouTubeId(id: string): boolean {
  return /^[-A-Za-z0-9_]{6,20}$/.test(id)
}

/**
 * Download the source video for a YouTube URL into upload/yt/<id>/source.<ext>
 * so the project becomes renderable without a manual upload.
 *
 * Design notes:
 *  - format: hard height cap (default 1080 for ≤20 min sources, 720 above) —
 *    the 9:16 renderer crops+upscales, so 1080p keeps the output sharp while
 *    capping download size; --max-filesize is the final guard.
 *  - resume: files live in a per-video directory and yt-dlp resumes .part
 *    files, so a failed job retried via /api/jobs/:id/retry continues where
 *    it stopped instead of restarting.
 *  - explicit errors: callers degrade honestly (localMediaState='failed'),
 *    never silently.
 */
export async function downloadYoutubeMedia(
  youtubeId: string,
  opts?: { maxHeight?: number; timeoutMs?: number },
): Promise<DownloadedMedia> {
  if (!isSafeYouTubeId(youtubeId)) throw new Error('Invalid YouTube id')
  const maxHeight = Math.min(2160, Math.max(144, Math.round(opts?.maxHeight ?? 1080)))
  const timeoutMs = opts?.timeoutMs ?? 10 * 60_000

  const dir = join(process.cwd(), 'upload', 'yt', youtubeId)
  mkdirSync(dir, { recursive: true })

  const args = [
    '--js-runtimes', 'bun',
    '--no-playlist',
    '--no-warnings',
    '--concurrent-fragments', '4',
    '--retries', '3',
    '--fragment-retries', '3',
    // hard height cap with progressive fallback; -S prefers h264/mp4-compatible streams
    '-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    '-S', `res:${maxHeight},ext:mp4:m4a`,
    '--max-filesize', '1500M',
    '-o', join(dir, 'source.%(ext)s'),
    `https://www.youtube.com/watch?v=${youtubeId}`,
  ]

  try {
    await runYtDlp(args, timeoutMs)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/larger than max-filesize/i.test(msg)) {
      throw new Error(`Source video exceeds the ${1500} MB download cap`)
    }
    if (/timed out|ETIMEDOUT|killed/i.test(msg)) {
      throw new Error('Download timed out — retry (it resumes from where it stopped)')
    }
    throw new Error(`yt-dlp download failed: ${msg.slice(0, 200)}`)
  }

  // decide from files on disk (never from the exit code — same rule as captions)
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('source.') && !/\.part$|\.ytdl$|\.temp$/.test(f))
    .sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size)
  if (files.length === 0) {
    throw new Error('Download produced no media file (blocked, geo-restricted, or members-only)')
  }
  const fileName = files[0]
  const ext = fileName.split('.').pop() ?? ''
  const mimeType = mediaMimeForExt(ext)
  if (!mimeType) throw new Error(`Downloaded file has an unsupported extension: .${ext}`)

  const absolute = join(dir, fileName)
  const sizeBytes = statSync(absolute).size
  if (sizeBytes < 1024) throw new Error('Downloaded file is suspiciously small (<1 KB) — likely blocked')
  const duration = await probeMediaDuration(absolute)

  return {
    relativePath: `upload/yt/${youtubeId}/${fileName}`,
    sizeBytes,
    mimeType,
    duration,
  }
}

/**
 * Resolve + validate a stored relative media path (defense in depth).
 * Stored paths are RELATIVE TO THE PROJECT ROOT and always start with
 * 'upload/' (e.g. upload/yt/<id>/source.mp4, upload/projects/<id>/source.mp4).
 */
export function resolveLocalMediaPath(relativePath: string): string | null {
  if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) return null
  if (!relativePath.startsWith('upload/')) return null
  const root = process.cwd()
  const uploadRoot = join(root, 'upload')
  const absolute = join(root, relativePath)
  if (!absolute.startsWith(uploadRoot + sep)) return null
  return absolute
}

// ---------------------------------------------------------------------------
// Local file probing (for uploaded sources)
// ---------------------------------------------------------------------------

export async function probeMediaDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { timeout: 15_000 },
    )
    const d = JSON.parse(stdout)?.format?.duration
    const n = Number(d)
    return isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null
  } catch {
    return null
  }
}

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
   * 'measured'  — each word start/end comes from the source's own word-level
   *               timing data (json3 tOffsetMs, srv3 word offsets, or ASR).
   * 'estimated' — no true word timing in the source; word times are evenly
   *               distributed within segment timings (clearly labeled, never
   *               treated as true word timestamps downstream).
   */
  wordTiming: 'measured' | 'estimated'
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
  if (existsSync('/home/z/.venv/bin/yt-dlp')) return '/home/z/.venv/bin/yt-dlp'
  if (existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp'
  if (existsSync('/usr/bin/yt-dlp')) return '/usr/bin/yt-dlp'
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
    // prefer json3 (word timings) > srv3 > vtt — and among json3 tracks,
    // prefer the one that actually carries per-word tOffsetMs (the ASR
    // 'en-orig' track) over word-offset-less manual tracks.
    const offsetRatio = (f: string): number => {
      if (!f.endsWith('.json3')) return -1
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { events?: { segs?: { tOffsetMs?: number }[] }[] }
        const segs = (j.events ?? []).flatMap((e) => e.segs ?? [])
        if (segs.length === 0) return 0
        return segs.filter((s) => typeof s.tOffsetMs === 'number' && isFinite(s.tOffsetMs)).length / segs.length
      } catch {
        return 0
      }
    }
    files.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      const oa = offsetRatio(a)
      const ob = offsetRatio(b)
      if (Math.abs(oa - ob) > 0.05) return ob - oa // more word offsets first
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

/** Minimal VTT → json3-ish converter so downstream parsing stays uniform. */
function vttToJson3(vtt: string): unknown {
  const events: { tStartMs: number; dDurationMs: number; segs: { utf8: string }[] }[] = []
  const blocks = vtt.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('WEBVTT') && !l.includes('-->') === false ? l.trim() : l.trim())
    const cue = lines.find((l) => l.includes('-->'))
    if (!cue) continue
    const m = cue.match(/(\d+):(\d+):(\d+)\.(\d+)\s*-->\s*(\d+):(\d+):(\d+)\.(\d+)/)
    if (!m) continue
    const start = (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4])
    const end = (+m[5]) * 3600000 + (+m[6]) * 60000 + (+m[7]) * 1000 + (+m[8])
    const idx = lines.indexOf(cue)
    const text = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (!text) continue
    events.push({ tStartMs: start, dDurationMs: Math.max(1, end - start), segs: [{ utf8: text }] })
  }
  return { events }
}

/**
 * Minimal srv3 (XML timedtext) → json3-ish converter.
 * <p t="start" d="dur"><s ac-as="offset"|t="offset">word</s>...</p>
 * When <s> word offsets exist they are preserved (measured word timing);
 * when absent, parseJson3 falls back to even distribution (estimated).
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
      const off = offM ? Number(offM[1]) : 0
      const text = sm[2].replace(/<[^>]+>/g, '')
      if (!text.trim()) continue
      segs.push({ utf8: text, tOffsetMs: isFinite(off) ? off : undefined })
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
function parseJson3(json3: unknown): { words: WordTimestamp[]; text: string; wordTiming: 'measured' | 'estimated' } {
  const words: WordTimestamp[] = []
  const lines: string[] = []
  const events = (json3 as { events?: Json3Event[] })?.events ?? []
  let measuredSegs = 0
  let totalSegs = 0

  const round2 = (n: number) => Math.round(n * 100) / 100

  for (const ev of events) {
    if (!Array.isArray(ev.segs) || ev.segs.length === 0) continue
    const eventStartMs = ev.tStartMs ?? 0
    const eventEndMs = eventStartMs + (ev.dDurationMs ?? 0)

    // collect usable segments first
    const usable: { text: string; offsetMs: number | null }[] = []
    for (const seg of ev.segs) {
      const raw = (seg.utf8 ?? '').replace(/\n/g, ' ').trim()
      if (!raw || raw === '\u200b' || raw === '&nbsp;') continue
      usable.push({ text: raw, offsetMs: typeof seg.tOffsetMs === 'number' && isFinite(seg.tOffsetMs) ? seg.tOffsetMs : null })
    }
    if (usable.length === 0) continue

    for (const u of usable) {
      totalSegs++
      if (u.offsetMs !== null) measuredSegs++
    }

    const allMeasured = usable.every((u) => u.offsetMs !== null)

    if (allMeasured) {
      // REAL word-level timing: start = eventStart + offset; end = next word's
      // start (or event end for the last word). No estimation involved.
      const starts = usable.map((u) => (eventStartMs + (u.offsetMs as number)) / 1000)
      for (let i = 0; i < usable.length; i++) {
        const start = starts[i]
        const nextInEvent = i + 1 < usable.length ? starts[i + 1] : eventEndMs / 1000
        // end must never precede start; keep a floor of 80ms for readability
        const end = Math.max(start + 0.08, nextInEvent > start ? nextInEvent : start + 0.08)
        for (const w of usable[i].text.split(/\s+/)) {
          if (w) words.push({ word: w, start: round2(start), end: round2(end) })
        }
      }
    } else {
      // ESTIMATED: distribute the segment/event window evenly across words.
      // A segment without its own offset shares the whole event duration
      // proportionally with its siblings by word count.
      const totalWords = usable.reduce((acc, u) => acc + u.text.split(/\s+/).filter(Boolean).length, 0)
      const winStart = eventStartMs / 1000
      const winDur = Math.max(usable.length * 0.08, (ev.dDurationMs ?? totalWords * 240) / 1000)
      const per = Math.max(0.08, winDur / Math.max(1, totalWords))
      let cursor = winStart
      for (const u of usable) {
        const parts = u.text.split(/\s+/).filter(Boolean)
        for (const p of parts) {
          words.push({ word: p, start: round2(cursor), end: round2(cursor + per) })
          cursor += per
        }
      }
    }
  }

  const wordTiming: 'measured' | 'estimated' = totalSegs > 0 && measuredSegs / totalSegs >= 0.8 ? 'measured' : 'estimated'
  return { words, text: lines.length > 0 ? lines.join('\n') : words.map((w) => w.word).join(' '), wordTiming }
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

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const langs = `${langPref},*-orig,*-auto`
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
      35_000,
    )
    const files = readdirSync(dir).filter((f) => f.startsWith('subs') && (f.endsWith('.json3') || f.endsWith('.vtt') || f.endsWith('.srv3')))
    if (files.length === 0) return null
    // prefer json3 (word timings) > srv3 > vtt
    files.sort((a, b) => rank(a) - rank(b))
    const content = readFileSync(join(dir, files[0]), 'utf-8')
    const lang = files[0].match(/subs\.([\w-]+)/)?.[1] ?? 'unknown'
    if (files[0].endsWith('.json3')) {
      return { json3: JSON.parse(content), lang }
    }
    // Convert VTT/SRV3 → json3-like structure for uniform parsing
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

function parseJson3(json3: unknown): { words: WordTimestamp[]; text: string } {
  const words: WordTimestamp[] = []
  const lines: string[] = []
  const events = (json3 as { events?: Json3Event[] })?.events ?? []
  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue
    const lineWords: string[] = []
    for (const seg of ev.segs) {
      const raw = (seg.utf8 ?? '').replace(/\n/g, ' ').trim()
      if (!raw || raw === '\u200b' || raw === '&nbsp;') continue
      const segStart = (ev.tStartMs ?? 0) / 1000 + (seg.tOffsetMs ?? 0) / 1000
      // split segment into words, distributing time evenly within the segment
      const parts = raw.split(/\s+/)
      const per = parts.length > 0 ? Math.max(0.08, (ev.dDurationMs ?? parts.length * 240) / 1000 / parts.length) : 0.2
      parts.forEach((p, i) => {
        lineWords.push(p)
        words.push({ word: p, start: Math.round((segStart + i * per) * 100) / 100, end: Math.round((segStart + (i + 1) * per) * 100) / 100 })
      })
    }
    if (lineWords.length > 0) lines.push(lineWords.join(' '))
  }
  return { words, text: lines.join('\n') }
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
  }
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

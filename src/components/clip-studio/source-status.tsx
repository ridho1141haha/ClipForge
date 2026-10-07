'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Database,
  FileText,
  Mic,
  ShieldCheck,
  AlertTriangle,
  Search,
  X,
  Copy,
  Check,
  ScrollText,
  Clock,
  BadgeCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { fmtDuration, type AnalyzeResult } from '@/lib/youtube'

// ---------------------------------------------------------------------------
// SourceStatusPanel — honest, at-a-glance provenance of the analysis inputs
// ---------------------------------------------------------------------------

const DURATION_SOURCE_META: Record<string, { label: string; tone: 'good' | 'warn' | 'bad'; title: string }> = {
  'yt-dlp': { label: 'yt-dlp', tone: 'good', title: 'Exact duration resolved via yt-dlp' },
  innertube: { label: 'innertube', tone: 'good', title: 'Duration resolved via YouTube player API' },
  ffprobe: { label: 'ffprobe', tone: 'good', title: 'Duration measured directly from the media file' },
  'user-provided': { label: 'manual', tone: 'warn', title: 'Server could not fetch duration — entered manually' },
  unavailable: { label: 'unavailable', tone: 'bad', title: 'Real duration not obtainable — analysis blocked' },
  unknown: { label: 'unknown', tone: 'warn', title: 'Duration provenance unknown' },
}

const TRANSCRIPT_SOURCE_META: Record<string, { label: string; tone: 'good' | 'warn' | 'bad'; title: string }> = {
  'youtube-captions': { label: 'YouTube captions', tone: 'good', title: 'Real captions fetched from YouTube (word-level timings)' },
  asr: { label: 'Whisper ASR', tone: 'good', title: 'Speech transcribed server-side with faster-whisper (word-level timings)' },
  manual: { label: 'manual paste', tone: 'warn', title: 'Transcript pasted by you — no word timings' },
  none: { label: 'none', tone: 'bad', title: 'No transcript — hooks cannot be verified' },
}

function Chip({ tone, title, children }: { tone: 'good' | 'warn' | 'bad'; title: string; children: React.ReactNode }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {children}
    </span>
  )
}

export function SourceStatusPanel({
  meta,
  analyzeResult,
  transcript,
  words,
  wordTiming,
  onOpenTranscript,
}: {
  meta: { duration?: number | null; durationSource?: string; title?: string } | null
  analyzeResult: AnalyzeResult | null
  transcript?: string | null
  words?: { word: string; start: number; end: number }[] | null
  wordTiming?: 'measured' | 'estimated' | null
  onOpenTranscript?: () => void
}) {
  if (!meta && !analyzeResult) return null
  const dSrc = DURATION_SOURCE_META[meta?.durationSource ?? 'unknown'] ?? DURATION_SOURCE_META.unknown
  const tSrc = TRANSCRIPT_SOURCE_META[analyzeResult?.transcriptSource ?? 'none'] ?? TRANSCRIPT_SOURCE_META.none
  const wordCount = words?.length ?? 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border/60 bg-card/50 p-3"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Database className="h-3 w-3" />
        Source data provenance
        <span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground/70">
          every decision is grounded in these inputs
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={dSrc.tone} title={dSrc.title}>
          <Clock className="h-3 w-3" />
          duration: {meta?.duration != null ? fmtDuration(meta.duration) : 'n/a'} · {dSrc.label}
        </Chip>
        <Chip tone={tSrc.tone} title={tSrc.title}>
          {tSrc.label === 'Whisper ASR' ? <Mic className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
          transcript: {tSrc.label}
        </Chip>
        {wordCount > 0 && (
          wordTiming === 'estimated' ? (
            <Chip
              tone="warn"
              title="Word timestamps are ESTIMATED (evenly distributed within segment timings) — the source had no word-level timing data. Boundaries/subtitles are approximate to segment accuracy."
            >
              <AlertTriangle className="h-3 w-3" />
              {wordCount.toLocaleString()} word timestamps · estimated
            </Chip>
          ) : (
            <Chip tone="good" title="Word-level timestamps MEASURED from the source (json3/srv3 offsets or ASR) — subtitle & context validation fully grounded">
              <BadgeCheck className="h-3 w-3" />
              {wordCount.toLocaleString()} word timestamps · measured
            </Chip>
          )
        )}
        {transcript && !wordCount && (
          <Chip tone="warn" title="Transcript text available but without word timings">
            {transcript.length.toLocaleString()} chars
          </Chip>
        )}
        {onOpenTranscript && (transcript || (words && words.length > 0)) && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onOpenTranscript}
          >
            <ScrollText className="h-3.5 w-3.5" />
            View transcript
          </Button>
        )}
      </div>
      {tSrc.tone === 'bad' && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-500/5 px-2 py-1.5 text-[10px] leading-relaxed text-rose-600 dark:text-rose-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          No transcript — hooks are omitted, context validation is treated as NO_TRANSCRIPT (low confidence), and every candidate is flagged unverified. Upload the media for ASR or paste a transcript for grounded analysis.
        </div>
      )}
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// TranscriptViewer — searchable transcript with word-timestamp list
// ---------------------------------------------------------------------------

export function TranscriptViewer({
  open,
  onOpenChange,
  title,
  transcript,
  words,
  source,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title?: string
  transcript?: string | null
  words?: { word: string; start: number; end: number }[] | null
  source?: string
}) {
  const [query, setQuery] = React.useState('')
  const [copied, setCopied] = React.useState(false)

  const wordsList = words ?? null
  const text = transcript ?? (wordsList && wordsList.length > 0 ? wordsList.map((w) => w.word).join(' ') : '') ?? ''
  const hits = React.useMemo(() => {
    if (!query.trim() || !text) return 0
    const q = query.toLowerCase()
    return text.toLowerCase().split(q).length - 1
  }, [query, text])

  const highlighted = React.useMemo(() => {
    if (!query.trim() || !text) return [{ t: text, hit: false }] as { t: string; hit: boolean }[]
    const parts: { t: string; hit: boolean }[] = []
    const lower = text.toLowerCase()
    const q = query.toLowerCase()
    let i = 0
    while (i < text.length) {
      const idx = lower.indexOf(q, i)
      if (idx === -1) {
        parts.push({ t: text.slice(i), hit: false })
        break
      }
      if (idx > i) parts.push({ t: text.slice(i, idx), hit: false })
      parts.push({ t: text.slice(idx, idx + q.length), hit: true })
      i = idx + q.length
    }
    return parts
  }, [query, text])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden rounded-2xl p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4 text-primary" />
            Transcript
          </DialogTitle>
          <DialogDescription className="text-xs">
            {title ? `${title.slice(0, 70)} · ` : ''}
            {source ? `source: ${source} · ` : ''}
            {words && words.length > 0 ? `${words.length.toLocaleString()} word timestamps` : text ? `${text.length.toLocaleString()} chars (no word timings)` : 'empty'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the transcript…"
              className="h-9 pl-8 text-sm"
            />
          </div>
          {query && (
            <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {hits} hit{hits === 1 ? '' : 's'}
            </span>
          )}
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 px-2" onClick={copy} title="Copy transcript">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9 w-9 px-0"
            onClick={() => setQuery('')}
            title="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="max-h-[55vh] overflow-y-auto px-5 py-4 scrollbar-thin" style={{ scrollbarWidth: 'thin' }}>
          {!text && !wordsList?.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No transcript available for this source.</p>
          ) : query && hits > 0 ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {highlighted.map((p, i) =>
                p.hit ? (
                  <mark key={i} className="rounded bg-primary/25 px-0.5 text-foreground">
                    {p.t}
                  </mark>
                ) : (
                  <span key={i}>{p.t}</span>
                ),
              )}
            </p>
          ) : query && hits === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No matches for “{query}”.
            </p>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
          )}

          {words && words.length > 0 && !query && (
            <div className="mt-5">
              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <ShieldCheck className="h-3 w-3 text-emerald-500" />
                Word-level timestamps ({words.length.toLocaleString()})
              </div>
              <div className="flex flex-wrap gap-x-1 gap-y-1 rounded-lg bg-muted/20 p-3">
                {words.slice(0, 800).map((w, i) => (
                  <span
                    key={i}
                    title={`${w.start.toFixed(2)}s → ${w.end.toFixed(2)}s`}
                    className="cursor-default rounded px-1 py-0.5 text-[11px] text-foreground/85 transition-colors hover:bg-primary/15"
                  >
                    {w.word}
                  </span>
                ))}
                {words.length > 800 && (
                  <span className="px-1 text-[11px] text-muted-foreground">
                    …and {(words.length - 800).toLocaleString()} more
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles,
  Loader2,
  Link2,
  Wand2,
  AlertCircle,
  Palette,
  ChevronDown,
  Check,
  Languages,
  Mic,
  UploadCloud,
  BadgeCheck,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { PLATFORMS, LANGUAGES, type YouTubeMeta } from '@/lib/youtube'
import { STYLE_PRESETS } from '@/lib/editplan'

export interface AnalyzeParams {
  url: string
  platform: string
  clipCount: number
  style: string
  targetDuration: number
  language: string
  transcript?: string
  manualDuration?: number
  words?: { word: string; start: number; end: number }[]
  projectId?: string
  preResolvedMeta?: Partial<YouTubeMeta> & { title: string }
  /** skip the async prepare job (fallback after a prepare failure) */
  skipPrepare?: boolean
}

interface Props {
  onAnalyze: (params: AnalyzeParams) => void
  loading: boolean
  error?: string | null
}

interface AsrState {
  phase: 'idle' | 'uploading' | 'working' | 'done' | 'error'
  uploadPct: number
  jobStage: string
  jobPct: number
  jobId?: string
  projectId?: string
  title?: string
  duration?: number
  durationSource?: string
  words?: { word: string; start: number; end: number }[]
  wordCount?: number
  error?: string
  fileName?: string
}

export function UrlInput({ onAnalyze, loading, error }: Props) {
  const [url, setUrl] = React.useState('')
  const [platform, setPlatform] = React.useState('shorts')
  const [clipCount, setClipCount] = React.useState(6)
  const [style, setStyle] = React.useState('podcast')
  const [targetDuration, setTargetDuration] = React.useState(45)
  const [language, setLanguage] = React.useState('auto')
  const [styleOpen, setStyleOpen] = React.useState(false)
  const [langOpen, setLangOpen] = React.useState(false)
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [transcript, setTranscript] = React.useState('')
  const [manualDuration, setManualDuration] = React.useState('')
  const [asr, setAsr] = React.useState<AsrState>({ phase: 'idle', uploadPct: 0, jobStage: '', jobPct: 0 })
  const asrFileRef = React.useRef<HTMLInputElement>(null)
  const asrPollRef = React.useRef<number>(0)
  const styleRef = React.useRef<HTMLDivElement>(null)
  const langRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (styleRef.current && !styleRef.current.contains(e.target as Node)) setStyleOpen(false)
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // clamp target duration to platform range
  React.useEffect(() => {
    const p = PLATFORMS.find((x) => x.id === platform)
    if (p) {
      const [min, max] = p.range
      setTargetDuration((d) => Math.max(min, Math.min(max, d)))
    }
  }, [platform])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    const isAsr = asr.phase === 'done'
    if (!url.trim() && !isAsr) return
    onAnalyze({
      url: isAsr && !url.trim() ? `upload://${asr.fileName ?? 'media'}` : url.trim(),
      platform,
      clipCount,
      style,
      targetDuration,
      language,
      transcript: transcript.trim() || undefined,
      manualDuration: manualDuration ? Number(manualDuration) : undefined,
      words: asr.phase === 'done' ? asr.words : undefined,
      projectId: asr.phase === 'done' ? asr.projectId : undefined,
      preResolvedMeta:
        asr.phase === 'done'
          ? {
              title: asr.title ?? 'Uploaded media',
              duration: asr.duration,
              durationSource: asr.durationSource,
              youtubeId: 'upload',
            }
          : undefined,
    })
  }

  // ---- ASR upload flow (Phase 2: local media → faster-whisper word timestamps) ----
  const startAsrUpload = (file: File) => {
    if (asrPollRef.current) window.clearTimeout(asrPollRef.current)
    setAsr({ phase: 'uploading', uploadPct: 0, jobStage: 'Uploading media…', jobPct: 0, fileName: file.name })
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', file.name.replace(/\.[^.]+$/, ''))
    fd.append('language', language)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/source/transcribe')
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100)
        setAsr((s) => ({ ...s, uploadPct: pct }))
      }
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status !== 202 && xhr.status !== 200) throw new Error(data.error ?? 'Upload failed')
        setAsr((s) => ({ ...s, phase: 'working', jobId: data.jobId, jobStage: 'Queued…', jobPct: 1 }))
        pollAsrJob(data.jobId)
      } catch (err: unknown) {
        setAsr((s) => ({ ...s, phase: 'error', error: err instanceof Error ? err.message : 'Upload failed' }))
      }
    }
    xhr.onerror = () => setAsr((s) => ({ ...s, phase: 'error', error: 'Upload failed (network error)' }))
    xhr.send(fd)
  }

  const pollAsrJob = (jobId: string) => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`)
        const data = await res.json()
        const job = data.job ?? {}
        if (job.status === 'COMPLETED') {
          const r = job.result ?? {}
          setAsr((s) => ({
            ...s,
            phase: 'done',
            jobStage: 'Transcription complete',
            jobPct: 100,
            projectId: r.projectId,
            title: r.title,
            duration: r.duration,
            durationSource: r.durationSource,
            words: r.words ?? [],
            wordCount: r.wordCount ?? (r.words?.length ?? 0),
          }))
          return
        }
        if (job.status === 'FAILED') {
          setAsr((s) => ({ ...s, phase: 'error', error: job.errorMessage ?? 'Transcription failed' }))
          return
        }
        setAsr((s) => ({ ...s, jobStage: job.stage ?? s.jobStage, jobPct: job.progress ?? s.jobPct }))
        asrPollRef.current = window.setTimeout(poll, 2000)
      } catch {
        asrPollRef.current = window.setTimeout(poll, 3000)
      }
    }
    poll()
  }

  React.useEffect(() => () => { if (asrPollRef.current) window.clearTimeout(asrPollRef.current) }, [])

  const examples = [
    { label: 'Podcast', url: 'https://www.youtube.com/watch?v=aircAruvnKk' },
    { label: 'Talk', url: 'https://www.youtube.com/watch?v=ZSpnfgE4m6M' },
  ]

  const activeStyle = STYLE_PRESETS.find((s) => s.id === style)
  const activeLang = LANGUAGES.find((l) => l.id === language) ?? LANGUAGES[0]

  return (
    <form onSubmit={submit} className="w-full">
      <div className="relative mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="group relative rounded-2xl border border-border/80 bg-card/60 p-1.5 shadow-xl shadow-black/5 backdrop-blur-xl"
        >
          <div className="absolute -inset-px -z-10 rounded-2xl bg-gradient-to-r from-primary/0 via-primary/20 to-primary/0 opacity-0 blur transition-opacity group-focus-within:opacity-100" />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a YouTube link…  e.g. https://youtube.com/watch?v=…"
                className="h-12 border-0 bg-transparent pl-10 pr-4 text-base shadow-none focus-visible:ring-0"
                disabled={loading}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button
              type="submit"
              disabled={loading || (!url.trim() && asr.phase !== 'done')}
              className="h-12 gap-2 rounded-xl px-6 text-base shadow-lg shadow-primary/30 sm:rounded-l-none"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analyzing
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" />
                  Auto-Clip
                </>
              )}
            </Button>
          </div>
        </motion.div>

        {/* Platform selector */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {PLATFORMS.map((p) => {
            const active = platform === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPlatform(p.id)}
                className={`group relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/30'
                    : 'border-border bg-card/60 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                }`}
              >
                <span className="text-sm leading-none">{p.icon}</span>
                {p.label}
                <span
                  className={`ml-1 rounded px-1 text-[10px] ${
                    active ? 'bg-primary-foreground/20' : 'bg-muted'
                  }`}
                >
                  {p.range[0]}–{p.range[1]}s
                </span>
              </button>
            )
          })}
        </div>

        {/* Style + language + duration + count row */}
        <div className="mx-auto mt-3 flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-stretch">
          {/* Language dropdown */}
          <div ref={langRef} className="relative flex-1">
            <button
              type="button"
              onClick={() => setLangOpen((v) => !v)}
              className="flex h-full w-full items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-left transition-colors hover:border-primary/40"
            >
              <Languages className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Subtitle lang
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <span>{activeLang.flag}</span>
                  <span className="truncate">{activeLang.id === 'auto' ? 'Auto' : activeLang.label}</span>
                </div>
              </div>
              <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${langOpen ? 'rotate-180' : ''}`} />
            </button>
            {langOpen && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto scrollbar-thin rounded-xl border bg-popover p-1 shadow-xl">
                {LANGUAGES.map((l) => {
                  const active = language === l.id
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => {
                        setLanguage(l.id)
                        setLangOpen(false)
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent ${
                        active ? 'bg-primary/10' : ''
                      }`}
                    >
                      <span className="text-base leading-none">{l.flag}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          {l.label}
                          {active && <Check className="h-3 w-3 text-primary" />}
                        </div>
                        <div className="text-[10px] text-muted-foreground">{l.native}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Style dropdown */}
          <div ref={styleRef} className="relative flex-1">
            <button
              type="button"
              onClick={() => setStyleOpen((v) => !v)}
              className="flex h-full w-full items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-left transition-colors hover:border-primary/40"
            >
              <Palette className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Editing style
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <span>{activeStyle?.icon}</span>
                  <span className="truncate">{activeStyle?.label ?? 'Podcast'}</span>
                </div>
              </div>
              <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${styleOpen ? 'rotate-180' : ''}`} />
            </button>
            {styleOpen && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto scrollbar-thin rounded-xl border bg-popover p-1 shadow-xl">
                {STYLE_PRESETS.map((s) => {
                  const active = style === s.id
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setStyle(s.id)
                        setStyleOpen(false)
                      }}
                      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent ${
                        active ? 'bg-primary/10' : ''
                      }`}
                    >
                      <span className="mt-0.5 text-base leading-none">{s.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          {s.label}
                          {active && <Check className="h-3 w-3 text-primary" />}
                        </div>
                        <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                          {s.desc}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Clip count */}
          <div className="flex flex-1 items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-3 py-2">
            <Label className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Clips
            </Label>
            <Slider
              value={[clipCount]}
              min={3}
              max={10}
              step={1}
              onValueChange={(v) => setClipCount(v[0])}
              className="flex-1"
            />
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/10 text-xs font-semibold text-primary tabular-nums">
              {clipCount}
            </span>
          </div>

          {/* Target duration */}
          <div className="flex flex-1 items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-3 py-2">
            <Label className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Length
            </Label>
            <Slider
              value={[targetDuration]}
              min={15}
              max={120}
              step={5}
              onValueChange={(v) => setTargetDuration(v[0])}
              className="flex-1"
            />
            <span className="grid h-5 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-xs font-semibold text-primary tabular-nums">
              {targetDuration}s
            </span>
          </div>
        </div>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mt-3 flex max-w-2xl items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
          </motion.div>
        )}

        {/* Example links */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            Try:
          </span>
          {examples.map((ex) => (
            <button
              key={ex.url}
              type="button"
              onClick={() => setUrl(ex.url)}
              className="rounded-full border border-border/60 bg-card/40 px-2.5 py-1 transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {ex.label}
            </button>
          ))}
        </div>

        {/* Advanced options (transcript + manual duration) */}
        <div className="mx-auto mt-3 max-w-2xl">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-lg border border-border/50 bg-card/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <Sparkles className="h-3 w-3 text-amber-500" />
            <span className="font-medium">Advanced: transcript grounding & manual duration</span>
            {transcript.trim() && (
              <Badge variant="secondary" className="ml-1 text-[9px] text-emerald-600">
                transcript: {transcript.trim().length} chars
              </Badge>
            )}
            <span className="ml-auto text-[10px]">{advancedOpen ? '▾' : '▸'}</span>
          </button>
          {advancedOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-2 space-y-2 overflow-hidden"
            >
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <p className="mb-2 text-[10px] leading-snug text-muted-foreground">
                  <strong className="text-amber-600 dark:text-amber-400">Auto-grounding:</strong> YouTube captions are fetched automatically when available (with word-level timestamps) — no paste needed.
                  If captions are unavailable, paste the real transcript (YouTube → transcript feature → copy) so hooks, subtitles and timestamps stay grounded in the actual spoken content. Without any transcript the AI cannot verify hooks — candidates are marked UNVERIFIED.
                </p>
                <textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  placeholder="Paste the video transcript here… (open the YouTube video → click the transcript button → copy-paste)"
                  rows={4}
                  className="w-full resize-y rounded-md border border-border/60 bg-background px-2.5 py-2 text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Label className="whitespace-nowrap text-[10px] text-muted-foreground">
                    Duration (sec) — used only if the server cannot fetch the real one:
                  </Label>
                  <input
                    type="number"
                    value={manualDuration}
                    onChange={(e) => setManualDuration(e.target.value)}
                    placeholder="auto (yt-dlp)"
                    min="1"
                    max="86400"
                    className="h-7 w-28 rounded-md border border-border/60 bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {manualDuration ? `${Math.floor(Number(manualDuration) / 60)}m ${Math.round(Number(manualDuration) % 60)}s` : 'real duration via yt-dlp → innertube; never estimated'}
                  </span>
                </div>

                {/* ---- ASR upload flow ---- */}
                <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                  <div className="mb-2 flex items-center gap-1.5">
                    <Mic className="h-3.5 w-3.5 text-violet-500" />
                    <span className="text-xs font-semibold text-foreground">
                      No transcript? Upload the media — server-side Whisper ASR
                    </span>
                    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-600 dark:text-violet-400">
                      word-level timestamps
                    </span>
                  </div>
                  <input
                    ref={asrFileRef}
                    type="file"
                    accept="video/*,audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) startAsrUpload(f)
                      e.target.value = ''
                    }}
                  />
                  {asr.phase === 'idle' || asr.phase === 'error' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 border-violet-500/40 text-violet-600 hover:bg-violet-500/10 dark:text-violet-400"
                        onClick={() => asrFileRef.current?.click()}
                        disabled={loading}
                      >
                        <UploadCloud className="h-3.5 w-3.5" />
                        Upload video / audio
                      </Button>
                      <span className="text-[10px] text-muted-foreground">
                        MP4 · MOV · WebM · M4A · MP3 · WAV — max 500 MB. Duration is measured with ffprobe, speech is transcribed with faster-whisper.
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="flex items-center gap-1.5 font-medium text-violet-600 dark:text-violet-400">
                          {asr.phase === 'done' ? <BadgeCheck className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          {asr.phase === 'uploading' && `Uploading ${asr.fileName} — ${asr.uploadPct}%`}
                          {asr.phase === 'working' && asr.jobStage}
                          {asr.phase === 'done' && `${asr.fileName} — transcribed`}
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {asr.phase === 'uploading' ? `${asr.uploadPct}%` : asr.phase !== 'done' ? `${asr.jobPct}%` : ''}
                        </span>
                      </div>
                      {asr.phase !== 'done' && (
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-violet-500/60 via-violet-500 to-violet-500 transition-all"
                            style={{ width: `${asr.phase === 'uploading' ? asr.uploadPct * 0.4 : 40 + asr.jobPct * 0.6}%` }}
                          />
                        </div>
                      )}
                      {asr.phase === 'done' && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                            <BadgeCheck className="h-3 w-3" /> {asr.wordCount} words with timestamps
                          </span>
                          {asr.duration != null && (
                            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              <Clock className="h-3 w-3" /> {Math.floor(asr.duration / 60)}m {Math.round(asr.duration % 60)}s (ffprobe)
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
                            ASR grounded — hit Auto-Clip
                          </span>
                          <button
                            type="button"
                            className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() => setAsr({ phase: 'idle', uploadPct: 0, jobStage: '', jobPct: 0 })}
                          >
                            reset
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </form>
  )
}

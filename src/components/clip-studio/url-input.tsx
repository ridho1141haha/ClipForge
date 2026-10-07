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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { PLATFORMS, LANGUAGES } from '@/lib/youtube'
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
}

interface Props {
  onAnalyze: (params: AnalyzeParams) => void
  loading: boolean
  error?: string | null
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
    if (!url.trim() || loading) return
    onAnalyze({
      url: url.trim(),
      platform,
      clipCount,
      style,
      targetDuration,
      language,
      transcript: transcript.trim() || undefined,
      manualDuration: manualDuration ? Number(manualDuration) : undefined,
    })
  }

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
              disabled={loading || !url.trim()}
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
                  <strong className="text-amber-600 dark:text-amber-400">Why?</strong> ClipForge never guesses content or duration. Without a transcript the AI cannot verify hooks — candidates are marked UNVERIFIED.
                  Paste the real transcript (YouTube → transcript feature → copy) so hooks, subtitles and timestamps are grounded in the actual spoken content.
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
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </form>
  )
}

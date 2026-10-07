'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  X,
  Sparkles,
  Loader2,
  Scissors,
  Camera,
  Image as ImageIcon,
  Clapperboard as AnimIcon,
  Volume2,
  Music,
  Type,
  AlertTriangle,
  Copy,
  Check,
  RefreshCw,
  FileJson,
  Play,
  Download,
  Terminal,
  FileText,
  Film as FilmIcon,
} from 'lucide-react'
import { fmtTime, type SuggestedClip, type YouTubeMeta } from '@/lib/youtube'
import {
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type EditPlan,
  type EditSegment,
  type SegmentType,
  scoreColor10,
} from '@/lib/editplan'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  clip: SuggestedClip | null
  meta: YouTubeMeta | null
  platform: string
  style: string
  targetDuration: number
  loading: boolean
  plan: EditPlan | null
  onGenerate: () => void
  onAutoEdit: () => void
  onRemotionEdit: () => void
}

export function EditPlanView({
  open,
  onOpenChange,
  clip,
  meta,
  platform,
  style,
  targetDuration,
  loading,
  plan,
  onGenerate,
  onAutoEdit,
  onRemotionEdit,
}: Props) {
  const [tab, setTab] = React.useState<'segments' | 'subtitles' | 'visuals' | 'cuts' | 'camera' | 'sound' | 'json'>('segments')
  const [copied, setCopied] = React.useState(false)
  const [downloadingScript, setDownloadingScript] = React.useState(false)
  const [scriptFmt, setScriptFmt] = React.useState<'sh' | 'ass' | 'json'>('sh')

  React.useEffect(() => {
    if (open && clip && !plan && !loading) {
      onGenerate()
    }
  }, [open, clip, plan, loading, onGenerate])

  if (!clip) return null

  const clipDur = clip.endTime - clip.startTime
  const scores = clip.scores

  const handleCopy = async () => {
    if (!plan) return
    await navigator.clipboard.writeText(JSON.stringify(plan, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const downloadScript = async (fmt: 'sh' | 'ass' | 'json') => {
    if (!plan || !meta) return
    setScriptFmt(fmt)
    setDownloadingScript(true)
    try {
      const res = await fetch('/api/render/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, youtubeId: meta.youtubeId, format: fmt }),
      })
      if (!res.ok) throw new Error('Failed to generate render script')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('content-disposition') ?? ''
      const m = cd.match(/filename="([^"]+)"/)
      a.download = m?.[1] ?? `clipforge-render.${fmt}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      console.error(e)
    } finally {
      setDownloadingScript(false)
    }
  }

  const tabs: { id: typeof tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'segments', label: 'Segments', icon: <Scissors className="h-3.5 w-3.5" />, count: plan?.selected_clip.segments.length },
    { id: 'subtitles', label: 'Subtitles', icon: <Type className="h-3.5 w-3.5" />, count: plan?.selected_clip.subtitles.length },
    { id: 'visuals', label: 'Visuals', icon: <ImageIcon className="h-3.5 w-3.5" />, count: plan?.selected_clip.visuals.length },
    { id: 'cuts', label: 'Cuts', icon: <Scissors className="h-3.5 w-3.5" />, count: plan?.selected_clip.cuts.length },
    { id: 'camera', label: 'Camera', icon: <Camera className="h-3.5 w-3.5" />, count: plan?.selected_clip.camera.length },
    { id: 'sound', label: 'Sound', icon: <Volume2 className="h-3.5 w-3.5" />, count: (plan?.selected_clip.sound_effects.length ?? 0) + (plan?.selected_clip.music.recommended ? 1 : 0) },
    { id: 'json', label: 'JSON', icon: <FileJson className="h-3.5 w-3.5" /> },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Sparkles className="h-4 w-4" />
                </span>
                <DialogTitle className="text-base">AI Edit Plan</DialogTitle>
                {plan && (
                  <Badge variant="secondary" className="text-[10px]">
                    {plan.project.style} · {plan.project.platform}
                  </Badge>
                )}
              </div>
              <DialogDescription className="text-xs">
                Structured plan for <span className="font-medium text-foreground">{clip.title}</span>
                {' · '}
                <span className="font-mono">{fmtTime(clip.startTime)}→{fmtTime(clip.endTime)}</span>
                {' · '}
                {clipDur.toFixed(0)}s
              </DialogDescription>
            </div>
            {plan && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopy}
                className="h-7 shrink-0 gap-1.5 text-xs"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy JSON'}
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* context risk banner */}
        {clip.contextRisk && (
          <div className="flex items-start gap-2 border-b border-rose-500/20 bg-rose-500/5 px-5 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
            <p className="text-xs text-rose-600 dark:text-rose-400">
              <span className="font-semibold">Context risk:</span> this clip may mislead the speaker without more context. Consider extending or adding context.
            </p>
          </div>
        )}

        {/* score breakdown bar */}
        {scores && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-5 py-2.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Scores
            </span>
            {(['hook', 'curiosity', 'payoff', 'standalone', 'shareability', 'emotion', 'context_safety'] as const).map((k) => {
              const v = (scores as any)[k]
              const c = scoreColor10(v)
              return (
                <span
                  key={k}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${c.bg} ${c.text}`}
                  title={`${k}: ${v}/10`}
                >
                  {k.replace('_', ' ')} {v}
                </span>
              )
            })}
            <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
              total {scores.total}/100
            </span>
          </div>
        )}

        {/* generated on-screen hook */}
        {plan?.selected_clip.generated_hook && (
          <div className="flex items-start gap-2 border-b border-border/40 bg-primary/5 px-5 py-2.5">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                On-screen hook (generated)
              </span>
              <p className="text-xs italic text-foreground/90">
                “{plan.selected_clip.generated_hook}”
              </p>
            </div>
          </div>
        )}

        {/* loading state */}
        {loading && !plan && (
          <div className="grid place-items-center py-16">
            <div className="text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
              <p className="mt-3 text-sm text-muted-foreground">
                AI Creative Director is composing the edit plan…
              </p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Segments · subtitles · camera · visuals · sound · pacing
              </p>
            </div>
          </div>
        )}

        {/* tabs + content */}
        {plan && !loading && (
          <>
            <div className="flex items-center gap-1 overflow-x-auto border-b border-border/60 px-3 scrollbar-thin">
              {tabs.map((t) => {
                const active = tab === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`relative flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
                      active
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t.icon}
                    {t.label}
                    {t.count != null && t.count > 0 && (
                      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 text-[9px] font-bold">
                        {t.count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="max-h-[52vh] overflow-y-auto scrollbar-thin p-4">
              <AnimatePresence mode="wait">
                <motion.div
                  key={tab}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {tab === 'segments' && <SegmentsView segments={plan.selected_clip.segments} clipStart={clip.startTime} clipEnd={clip.endTime} />}
                  {tab === 'subtitles' && <SubtitlesView subtitles={plan.selected_clip.subtitles} />}
                  {tab === 'visuals' && <VisualsView visuals={plan.selected_clip.visuals} />}
                  {tab === 'cuts' && <CutsView cuts={plan.selected_clip.cuts} />}
                  {tab === 'camera' && <CameraView camera={plan.selected_clip.camera} />}
                  {tab === 'sound' && <SoundView soundEffects={plan.selected_clip.sound_effects} music={plan.selected_clip.music} />}
                  {tab === 'json' && (
                    <pre className="overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] leading-relaxed scrollbar-thin">
                      <code className="font-mono text-muted-foreground">{JSON.stringify(plan, null, 2)}</code>
                    </pre>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </>
        )}

        {/* footer */}
        <div className="border-t border-border/60 p-4">
          {/* auto-edit actions */}
          {plan && !loading && (
            <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={onAutoEdit}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Play className="h-3.5 w-3.5" />
                  Auto-Edit Preview
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onRemotionEdit}
                  className="h-8 gap-1.5 text-xs"
                  title="Open interactive Remotion video editor"
                >
                  <FilmIcon className="h-3.5 w-3.5" />
                  Remotion Editor
                </Button>
                <div className="ml-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="hidden sm:inline">Render locally:</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadScript('sh')}
                  disabled={downloadingScript}
                  className="h-8 gap-1.5 text-xs"
                  title="Download ffmpeg shell script — run locally with your source video to render the actual MP4"
                >
                  <Terminal className="h-3.5 w-3.5" />
                  .sh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadScript('ass')}
                  disabled={downloadingScript}
                  className="h-8 gap-1.5 text-xs"
                  title="Download .ass subtitle file with emphasis styling"
                >
                  <Type className="h-3.5 w-3.5" />
                  .ass
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadScript('json')}
                  disabled={downloadingScript}
                  className="h-8 gap-1.5 text-xs"
                  title="Download full render recipe JSON"
                >
                  <FileJson className="h-3.5 w-3.5" />
                  .json
                </Button>
                {downloadingScript && (
                  <span className="text-[10px] text-muted-foreground">Generating {scriptFmt}…</span>
                )}
              </div>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                <Sparkles className="mr-1 inline h-2.5 w-2.5 text-primary" />
                Auto-Edit Preview applies the plan to the YouTube video live in your browser (cuts, zoom, subtitles, sound).
                The <code className="rounded bg-muted px-1">.sh</code> script is runnable with ffmpeg + your local source for actual rendering.
              </p>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="rounded bg-muted/60 px-1.5 py-0.5">{style}</span>
              <span className="rounded bg-muted/60 px-1.5 py-0.5">{platform}</span>
              <span className="rounded bg-muted/60 px-1.5 py-0.5">{targetDuration}s</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onGenerate}
                disabled={loading}
                className="h-8 gap-1.5 text-xs"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                Regenerate
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)} className="h-8 text-xs">
                Done
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- sub-views ----

function SegmentsView({ segments, clipStart, clipEnd }: { segments: EditSegment[]; clipStart: number; clipEnd: number }) {
  if (segments.length === 0) return <Empty label="No segments generated" />
  const total = Math.max(clipEnd - clipStart, 1)
  return (
    <div className="space-y-3">
      {/* segment timeline strip */}
      <div className="relative h-8 w-full overflow-hidden rounded-lg bg-muted/40 ring-1 ring-inset ring-border/40">
        {segments.map((s, i) => {
          const left = ((s.start - clipStart) / total) * 100
          const width = ((s.end - s.start) / total) * 100
          const color = SEGMENT_COLORS[s.type as SegmentType] ?? 'bg-muted'
          return (
            <div
              key={i}
              className={`absolute top-1 bottom-1 rounded ${color} opacity-80`}
              style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }}
              title={`${SEGMENT_LABELS[s.type as SegmentType] ?? s.type}: ${fmtTime(s.start)}→${fmtTime(s.end)}`}
            >
              <span className="flex h-full items-center justify-center text-[9px] font-bold text-white">
                {SEGMENT_LABELS[s.type as SegmentType] ?? s.type}
              </span>
            </div>
          )
        })}
      </div>
      {/* segments list */}
      {segments.map((s, i) => {
        const color = SEGMENT_COLORS[s.type as SegmentType] ?? 'bg-muted'
        return (
          <div key={i} className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
              <span className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--foreground)' }}>
                {SEGMENT_LABELS[s.type as SegmentType] ?? s.type}
              </span>
              <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                {fmtTime(s.start)} → {fmtTime(s.end)}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-foreground/80">{s.purpose}</p>
            {s.subtitle && (
              <p className="mt-1.5 rounded bg-muted/30 px-2 py-1 text-xs italic text-muted-foreground">
                “{s.subtitle}”
              </p>
            )}
            {s.emphasis_words.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {s.emphasis_words.map((w, j) => (
                  <span key={j} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {w}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SubtitlesView({ subtitles }: { subtitles: EditPlan['selected_clip']['subtitles'] }) {
  if (subtitles.length === 0) return <Empty label="No subtitles generated" />
  return (
    <div className="space-y-1.5">
      {subtitles.map((s, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg border border-border/40 bg-card/40 p-2">
          <span className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtTime(s.start)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-foreground/90">
              {renderEmphasis(s.text, s.emphasis_words, s.emphasis_type)}
            </p>
            {s.emphasis_words.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {s.emphasis_words.map((w, j) => (
                  <span key={j} className="rounded bg-primary/10 px-1 text-[9px] font-medium text-primary">
                    {w}
                  </span>
                ))}
                {s.emphasis_type && (
                  <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                    {s.emphasis_type}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function VisualsView({ visuals }: { visuals: EditPlan['selected_clip']['visuals'] }) {
  if (visuals.length === 0) return <Empty label="No visuals recommended — source is strong enough on its own" />
  return (
    <div className="space-y-3">
      {visuals.map((v, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
          <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
            <ImageIcon className="h-3.5 w-3.5 text-primary" />
            <Badge variant="secondary" className="text-[10px]">{v.type}</Badge>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {fmtTime(v.start)} → {fmtTime(v.end)}
            </span>
            {v.transition && (
              <span className="ml-auto rounded bg-muted/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {v.transition}
              </span>
            )}
          </div>
          <div className="p-3">
            <p className="text-xs text-foreground/80">
              <span className="font-semibold">Purpose:</span> {v.purpose}
            </p>
            <div className="mt-2 rounded-md bg-muted/30 p-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Image generation prompt
              </p>
              <p className="mt-1 text-xs italic text-foreground/80">{v.prompt}</p>
            </div>
            <span className="mt-2 inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              aspect {v.aspect_ratio}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function CutsView({ cuts }: { cuts: EditPlan['selected_clip']['cuts'] }) {
  if (cuts.length === 0) return <Empty label="No cuts recommended — pacing is natural" />
  return (
    <div className="space-y-2">
      {cuts.map((c, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg border border-border/40 bg-card/40 p-2.5">
          <Scissors className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {fmtTime(c.start)} → {fmtTime(c.end)}
            </span>
            <p className="mt-0.5 text-xs text-foreground/80">{c.reason}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function CameraView({ camera }: { camera: EditPlan['selected_clip']['camera'] }) {
  if (camera.length === 0) return <Empty label="No camera movements recommended" />
  return (
    <div className="space-y-2">
      {camera.map((c, i) => (
        <div key={i} className="rounded-lg border border-border/40 bg-card/40 p-3">
          <div className="flex items-center gap-2">
            <Camera className="h-3.5 w-3.5 text-violet-500" />
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {fmtTime(c.start)} → {fmtTime(c.end)}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-muted-foreground">{c.scale_start.toFixed(2)}×</span>
              <span className="text-muted-foreground/60">→</span>
              <span className="font-mono text-[10px] font-bold text-violet-500">{c.scale_end.toFixed(2)}×</span>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-foreground/80">{c.reason}</p>
          {/* scale visualization */}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
                style={{ width: `${((c.scale_end - 1) / 0.18) * 100}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function SoundView({
  soundEffects,
  music,
}: {
  soundEffects: EditPlan['selected_clip']['sound_effects']
  music: EditPlan['selected_clip']['music']
}) {
  return (
    <div className="space-y-3">
      {/* music */}
      <div className={`rounded-lg border p-3 ${music.recommended ? 'border-violet-500/30 bg-violet-500/5' : 'border-border/40 bg-card/40'}`}>
        <div className="flex items-center gap-2">
          <Music className="h-3.5 w-3.5 text-violet-500" />
          <span className="text-xs font-semibold">Music</span>
          {music.recommended ? (
            <Badge className="text-[10px]">Recommended</Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground">Not recommended</span>
          )}
        </div>
        {music.recommended && (
          <div className="mt-2 space-y-1.5 text-xs text-foreground/80">
            {music.style && (
              <p>
                <span className="font-semibold">Style:</span> {music.style}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className="font-semibold">Intensity:</span>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-violet-500" style={{ width: `${music.intensity * 100}%` }} />
              </div>
              <span className="tabular-nums">{Math.round(music.intensity * 100)}%</span>
            </div>
            <p>
              <span className="font-semibold">Ducking:</span> {music.ducking_percent}% during speech
            </p>
          </div>
        )}
      </div>
      {/* sound effects */}
      {soundEffects.length === 0 ? (
        <Empty label="No sound effects recommended" />
      ) : (
        <div className="space-y-1.5">
          {soundEffects.map((s, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 p-2">
              <Volume2 className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium capitalize">{s.type}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                @ {fmtTime(s.start)} · {s.duration.toFixed(1)}s
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-amber-500" style={{ width: `${s.intensity * 100}%` }} />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(s.intensity * 100)}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
      {label}
    </div>
  )
}

function renderEmphasis(text: string, words: string[], type?: string) {
  if (!words || words.length === 0) return text
  // highlight emphasis words inline
  const parts: React.ReactNode[] = []
  let remaining = text
  const lower = text.toLowerCase()
  // simple highlight loop
  let cursor = 0
  const matches: { start: number; end: number; word: string }[] = []
  words.forEach((w) => {
    const wlow = w.toLowerCase()
    let idx = lower.indexOf(wlow, cursor)
    while (idx !== -1) {
      matches.push({ start: idx, end: idx + w.length, word: w })
      idx = lower.indexOf(wlow, idx + 1)
    }
  })
  matches.sort((a, b) => a.start - b.start)
  let pos = 0
  const seen = new Set<number>()
  matches.forEach((m) => {
    if (m.start < pos || seen.has(m.start)) return
    if (m.start > pos) parts.push(text.slice(pos, m.start))
    parts.push(
      <mark
        key={m.start}
        className={`rounded px-0.5 ${
          type === 'uppercase'
            ? 'uppercase font-bold'
            : type === 'color'
            ? 'text-primary font-bold'
            : type === 'background'
            ? 'bg-primary/20 font-bold'
            : 'font-bold text-primary'
        }`}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    )
    pos = m.end
    seen.add(m.start)
  })
  if (pos < text.length) parts.push(text.slice(pos))
  return <>{parts}</>
}

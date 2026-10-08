'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  UploadCloud,
  Film,
  X,
  Check,
  Loader2,
  Download,
  Play,
  AlertCircle,
  FileVideo,
  Sparkles,
  Scissors,
  Wand2,
  CloudDownload,
  HardDriveUpload,
  Image as ImageIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { type EditPlan } from '@/lib/editplan'
import { buildRenderRecipe, buildRecipeJSON } from '@/lib/render-recipe'
import { outputDuration as planOutputDuration } from '@/lib/subtitles'
import { mapKeepRanges, sourceTimeAtOutput } from '@/lib/keep-ranges'
import { fmtTime, fmtDuration } from '@/lib/youtube'
import type { Cut } from '@/lib/subtitles'

/** ms → m:ss (clock for elapsed / ETA readouts). */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

interface Props {
  plan: EditPlan | null
  /** current project — enables the server-side source media (render without upload) */
  projectId?: string | null
  /** server-side source media state for the project (downloaded YouTube source or persisted upload) */
  projectMedia?: { state?: string | null; size?: number | null; error?: string | null } | null
  /** fired when a render job is accepted — lets the render-history panel live-track it */
  onJobStarted?: (jobId: string) => void
  // optional: when invoked from library with a stored clip plan
}

type Phase = 'idle' | 'uploading' | 'rendering' | 'done' | 'error'
type SourceMode = 'local' | 'upload'

export function UploadRender({ plan, projectId, projectMedia, onJobStarted }: Props) {
  const localReady = Boolean(projectId && projectMedia?.state === 'ready')
  const [sourceMode, setSourceMode] = React.useState<SourceMode>(localReady ? 'local' : 'upload')
  const [file, setFile] = React.useState<File | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [phase, setPhase] = React.useState<Phase>('idle')
  const [progress, setProgress] = React.useState(0)
  const [stage, setStage] = React.useState('')
  const [jobId, setJobId] = React.useState<string | null>(null)
  const [renderedUrl, setRenderedUrl] = React.useState<string | null>(null)
  const [renderedInfo, setRenderedInfo] = React.useState<{ size: number; duration: number; width: number; height: number; durationOk: boolean } | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [cancelling, setCancelling] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [timing, setTiming] = React.useState<{ elapsedMs: number; etaMs: number | null }>({ elapsedMs: 0, etaMs: null })
  const [hasCover, setHasCover] = React.useState(false)
  const [coverUrl, setCoverUrl] = React.useState<string | null>(null)
  // ---- cover-frame picker state ----
  // coverT is OUTPUT time (seconds into the RENDERED video). null = no custom
  // cover. The preview canvas maps output → source via the SAME keep-range
  // math the renderer consumes (preview == render parity).
  const [coverT, setCoverT] = React.useState<number | null>(null)
  const [coverSeeking, setCoverSeeking] = React.useState(false)
  const coverVideoRef = React.useRef<HTMLVideoElement | null>(null)
  const coverCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const coverFileUrlRef = React.useRef<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const pollRef = React.useRef<number>(0)
  const stoppedRef = React.useRef(false)
  // ETA tracker: rolling (time, progress) samples from REAL poll data — no fake
  // countdown. ETA comes from the recent slope, clamped to sane bounds.
  const samplesRef = React.useRef<{ t: number; p: number }[]>([])
  const startRef = React.useRef<number>(0)

  // keep the default source in sync when the project state changes
  React.useEffect(() => {
    setSourceMode(localReady ? 'local' : 'upload')
  }, [localReady])

  // output duration after cuts — a FULLY-CUT plan produces 0s and must NOT
  // reach the renderer (it would be rejected with EMPTY_OUTPUT; the button is
  // disabled here with an honest explanation instead)
  const outputDurationSec = React.useMemo(() => {
    if (!plan) return 0
    const sc = plan.selected_clip
    const cuts = (sc.cuts ?? []).filter((c: Cut) => c.end > c.start) as Cut[]
    return planOutputDuration(sc.start, sc.end, cuts)
  }, [plan])
  const emptyEdit = outputDurationSec < 0.2

  const canRender = (sourceMode === 'local' ? localReady : !!file) && !!plan && !emptyEdit

  // ---- cover preview: source URL for the hidden <video> ----
  // server source → owner-scoped media stream; upload mode → local object URL
  const coverMediaUrl = React.useMemo(() => {
    if (!plan) return null
    if (sourceMode === 'local' && projectId && projectMedia?.state === 'ready') return `/api/media/${projectId}`
    if (sourceMode === 'upload' && file) return coverFileUrlRef.current ?? undefined
    return null
  }, [plan, sourceMode, projectId, projectMedia?.state, file])

  // keep (re)creating the object URL in effects (not during render)
  React.useEffect(() => {
    if (sourceMode === 'upload' && file) {
      const url = URL.createObjectURL(file)
      coverFileUrlRef.current = url
      return () => {
        URL.revokeObjectURL(url)
        if (coverFileUrlRef.current === url) coverFileUrlRef.current = null
      }
    }
  }, [sourceMode, file])

  // keep-range map for the CURRENT plan — output time → source time
  const coverRanges = React.useMemo(() => {
    if (!plan) return []
    const sc = plan.selected_clip
    const cuts = (sc.cuts ?? []).filter((c: Cut) => c.end > c.start) as Cut[]
    return mapKeepRanges(sc.start, sc.end, cuts)
  }, [plan])

  // draw the source frame for the chosen OUTPUT time (9:16 cover-fill crop,
  // mirroring the renderer's scale+crop filter order)
  const drawCoverFrame = React.useCallback(() => {
    const v = coverVideoRef.current
    const canvas = coverCanvasRef.current
    if (!v || !canvas || !v.videoWidth) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight)
    const dw = v.videoWidth * scale
    const dh = v.videoHeight * scale
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh)
    setCoverSeeking(false)
  }, [])

  // when coverT changes: map output → source, seek the hidden video, draw
  React.useEffect(() => {
    const v = coverVideoRef.current
    if (coverT == null || !v || !coverMediaUrl) return
    const srcT = sourceTimeAtOutput(coverRanges, coverT)
    setCoverSeeking(true)
    let cancelled = false
    const onSeeked = () => {
      if (cancelled) return
      drawCoverFrame()
    }
    v.addEventListener('seeked', onSeeked)
    try {
      if (Math.abs(v.currentTime - srcT) > 0.02) v.currentTime = srcT
      else drawCoverFrame()
    } catch {
      setCoverSeeking(false)
    }
    return () => {
      cancelled = true
      v.removeEventListener('seeked', onSeeked)
    }
  }, [coverT, coverMediaUrl, coverRanges, drawCoverFrame])

  const onFileSelect = (f: File) => {
    if (!f.type.startsWith('video/')) {
      setError('Please select a video file (MP4, MOV, WebM…)')
      return
    }
    setError(null)
    setFile(f)
    setPhase('idle')
    setProgress(0)
    setStage('')
    setRenderedUrl(null)
    setRenderedInfo(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) onFileSelect(f)
  }

  const startRender = async () => {
    if (!plan) return
    if (emptyEdit) {
      setPhase('error')
      setError('This edit removes the entire clip — there is nothing left to render. Reduce the cut ranges in the editor.')
      return
    }
    if (sourceMode === 'upload' && !file) return
    setPhase('rendering')
    setProgress(0)
    setStage('Queuing…')
    setError(null)
    setNotice(null)
    setRenderedUrl(null)
    setRenderedInfo(null)
    setHasCover(false)
    setCoverUrl(null)
    samplesRef.current = []
    startRef.current = Date.now()
    setTiming({ elapsedMs: 0, etaMs: null })
    try {
      const recipe = buildRenderRecipe(plan, 'upload')
      // CRITICAL: send the RENDERER recipe JSON (keep_ranges + subtitles_ass +
      // OUTPUT-time camera keyframes + duration), NOT the raw RenderRecipe.
      // The raw object has none of those — the renderer would silently render
      // the full clip WITHOUT cuts and WITHOUT subtitles.
      const recipeJson = buildRecipeJSON(recipe, { coverTimestamp: coverT })
      let res: Response
      if (sourceMode === 'local' && projectId && localReady) {
        // project-source render: the proxy streams the server-side media to the
        // renderer — no browser upload needed
        setStage('Preparing source…')
        res = await fetch('/api/render-proxy/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipe: recipeJson, projectId }),
        })
      } else if (file) {
        const formData = new FormData()
        formData.append('video', file)
        formData.append('recipe', recipeJson)
        // Use Next.js API proxy to avoid CORS — proxies to localhost:3003
        res = await fetch('/api/render-proxy/render', {
          method: 'POST',
          body: formData,
        })
      } else {
        throw new Error('No source video selected')
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setJobId(data.id)
      setStage('Queued…')
      onJobStarted?.(data.id)
      pollJob(data.id)
    } catch (e: any) {
      setPhase('error')
      setError(e.message)
    }
  }

  const recordSample = (p: number) => {
    const now = Date.now()
    const samples = samplesRef.current
    samples.push({ t: now, p })
    if (samples.length > 8) samples.shift()
    const elapsedMs = now - startRef.current
    // slope from the earliest sample at least 2s old (avoid divide-by-tiny noise)
    let etaMs: number | null = null
    const first = samples.find((s) => now - s.t >= 2000) ?? (samples.length >= 4 ? samples[0] : undefined)
    if (first && now - first.t >= 2000 && p > first.p) {
      const slope = (p - first.p) / (now - first.t) // % per ms
      const remaining = Math.max(0, 100 - p)
      const eta = remaining / slope
      // clamp: 2s … 12 min (renders here are 20-60s outputs on a local box)
      etaMs = Math.min(12 * 60_000, Math.max(2_000, eta))
    }
    setTiming({ elapsedMs, etaMs })
  }

  const cancelRender = async () => {
    if (!jobId || cancelling) return
    setCancelling(true)
    try {
      await fetch(`/api/render-proxy/jobs/${jobId}/cancel`, { method: 'POST' })
      // poll loop will observe status 'cancelled' and wind down
    } catch {
      // cancel endpoint unavailable (old renderer?) — stop polling locally
      stoppedRef.current = true
      clearTimeout(pollRef.current)
      setPhase('idle')
      setNotice('Render cancelled.')
      setCancelling(false)
    }
  }

  const pollJob = (id: string) => {
    stoppedRef.current = false
    const poll = async () => {
      if (stoppedRef.current) return
      try {
        const res = await fetch(`/api/render-proxy/jobs/${id}`)
        const job = await res.json()
        setProgress(job.progress ?? 0)
        setStage(job.stage ?? '')
        recordSample(job.progress ?? 0)
        if (job.status === 'done') {
          setPhase('done')
          setRenderedInfo({
            size: job.size ?? 0,
            duration: job.duration ?? 0,
            width: job.width ?? 1080,
            height: job.height ?? 1920,
            durationOk: job.durationOk !== false,
          })
          setHasCover(job.hasCover === true)
          // fetch the rendered file
          const dlRes = await fetch(`/api/render-proxy/jobs/${id}/download`)
          const blob = await dlRes.blob()
          const url = URL.createObjectURL(blob)
          setRenderedUrl(url)
          // fetch the cover frame when the renderer extracted one
          if (job.hasCover) {
            try {
              const cRes = await fetch(`/api/render-proxy/jobs/${id}/cover`)
              if (cRes.ok) {
                const cBlob = await cRes.blob()
                setCoverUrl(URL.createObjectURL(cBlob))
              }
            } catch { /* cover is optional — never fail the result card */ }
          }
          return
        }
        if (job.status === 'error') {
          setPhase('error')
          setError(job.error ?? 'Render failed')
          return
        }
        // 404 = job unknown to the proxy (expired after 10 min, or not owned).
        // Surface it instead of polling forever.
        if (res.status === 404) {
          setPhase('error')
          setError('Render job not found — it may have expired (results are kept for 10 minutes) or belongs to another session.')
          return
        }
        if (job.status === 'cancelled') {
          setPhase('idle')
          setCancelling(false)
          setNotice('Render cancelled — no partial file is kept.')
          return
        }
        pollRef.current = window.setTimeout(poll, 1000)
      } catch {
        pollRef.current = window.setTimeout(poll, 2000)
      }
    }
    poll()
  }

  React.useEffect(() => {
    return () => {
      clearTimeout(pollRef.current)
      if (renderedUrl) URL.revokeObjectURL(renderedUrl)
      if (coverUrl) URL.revokeObjectURL(coverUrl)
    }
  }, [renderedUrl, coverUrl])

  const reset = () => {
    stoppedRef.current = true
    clearTimeout(pollRef.current)
    if (renderedUrl) URL.revokeObjectURL(renderedUrl)
    if (coverUrl) URL.revokeObjectURL(coverUrl)
    setFile(null)
    setPhase('idle')
    setProgress(0)
    setStage('')
    setJobId(null)
    setRenderedUrl(null)
    setRenderedInfo(null)
    setError(null)
    setNotice(null)
    setCancelling(false)
    setHasCover(false)
    setCoverUrl(null)
    setCoverT(null)
    samplesRef.current = []
    setTiming({ elapsedMs: 0, etaMs: null })
  }

  const downloadRendered = () => {
    if (!renderedUrl) return
    const a = document.createElement('a')
    a.href = renderedUrl
    a.download = `clipforge_${(plan?.selected_clip.title ?? 'render').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40)}.mp4`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const downloadCover = () => {
    if (!coverUrl) return
    const a = document.createElement('a')
    a.href = coverUrl
    a.download = `cover_${(plan?.selected_clip.title ?? 'clip').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40)}.jpg`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center gap-2">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
          <Wand2 className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Render your clip</h3>
          <p className="text-xs text-muted-foreground">
            {localReady
              ? 'Your source video is already on the server — render directly, or upload a different file.'
              : 'Upload your source video and we\u2019ll render it into a 9:16 MP4 with the AI edit plan applied — cuts, subtitles, camera zoom.'}
          </p>
        </div>
      </div>

      {/* plan requirement notice */}
      {!plan && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="text-xs">
            <p className="font-medium text-amber-700 dark:text-amber-400">No edit plan selected</p>
            <p className="mt-0.5 text-muted-foreground">
              Generate an AI edit plan on any clip first, then come back here to render. The plan tells the renderer which cuts to make, subtitles to burn, and zoom to apply.
            </p>
          </div>
        </div>
      )}

      {/* source selector (only when a server-side source exists) */}
      {projectId && (projectMedia?.state === 'ready' || projectMedia?.state === 'failed') && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Render source">
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === 'local'}
              disabled={projectMedia?.state !== 'ready'}
              onClick={() => setSourceMode('local')}
              className={`flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all ${
                sourceMode === 'local'
                  ? 'border-primary/60 bg-primary/10 shadow-sm ring-1 ring-primary/30'
                  : 'border-border/60 bg-card/40 hover:border-primary/30 hover:bg-card/70'
              } ${projectMedia?.state !== 'ready' ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${sourceMode === 'local' ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                <CloudDownload className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">Server source</p>
                <p className="text-[10px] text-muted-foreground">
                  {projectMedia?.state === 'ready'
                    ? `Downloaded / saved · ${projectMedia.size ? `${(projectMedia.size / 1024 / 1024).toFixed(1)} MB` : 'ready'}`
                    : 'Unavailable'}
                </p>
              </div>
              {sourceMode === 'local' && projectMedia?.state === 'ready' && (
                <Check className="ml-auto h-4 w-4 shrink-0 text-primary" strokeWidth={3} />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === 'upload'}
              onClick={() => setSourceMode('upload')}
              className={`flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all ${
                sourceMode === 'upload'
                  ? 'border-primary/60 bg-primary/10 shadow-sm ring-1 ring-primary/30'
                  : 'border-border/60 bg-card/40 hover:border-primary/30 hover:bg-card/70'
              }`}
            >
              <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${sourceMode === 'upload' ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                <HardDriveUpload className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">Your file</p>
                <p className="text-[10px] text-muted-foreground">Upload MP4 / MOV / WebM</p>
              </div>
              {sourceMode === 'upload' && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" strokeWidth={3} />}
            </button>
          </div>
          {projectMedia?.state === 'failed' && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              Auto-download failed{projectMedia.error ? ` (${projectMedia.error})` : ''} — upload the file below to render.
            </p>
          )}
        </div>
      )}

      {/* drop zone (upload mode) */}
      {sourceMode === 'upload' && (
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative cursor-pointer overflow-hidden rounded-xl border-2 border-dashed p-6 text-center transition-all ${
          dragOver
            ? 'border-primary bg-primary/10 scale-[1.01]'
            : file
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-border/60 bg-card/40 hover:border-primary/40 hover:bg-card/60'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFileSelect(f)
          }}
        />
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
              <FileVideo className="h-5 w-5" />
            </div>
            <div className="text-left">
              <p className="text-sm font-semibold">{file.name}</p>
              <p className="text-xs text-muted-foreground">
                {(file.size / 1024 / 1024).toFixed(2)} MB · {file.type || 'video'}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); reset() }}
              className="ml-2 h-7 px-2"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div>
            <motion.div
              animate={dragOver ? { y: -4 } : { y: 0 }}
              className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-xl bg-primary/10 text-primary"
            >
              <UploadCloud className="h-6 w-6" />
            </motion.div>
            <p className="text-sm font-medium">Drop your video here, or click to browse</p>
            <p className="mt-1 text-xs text-muted-foreground">
              MP4, MOV, WebM, AVI · up to ~500MB
            </p>
          </div>
        )}
      </div>
      )}

      {/* server source card (local mode) */}
      {sourceMode === 'local' && localReady && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
            <CloudDownload className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Source video on server</p>
            <p className="text-xs text-muted-foreground">
              {projectMedia?.size ? `${(projectMedia.size / 1024 / 1024).toFixed(1)} MB · ` : ''}rendered directly — no upload needed
            </p>
          </div>
          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400">
            render-ready
          </Badge>
        </div>
      )}

      {/* plan summary */}
      {plan && (
        <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card/40 p-4">
          {/* subtle gradient accent rail */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-primary/60 via-primary/20 to-transparent"
          />
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            Edit plan to apply
          </div>
          <p className="text-sm font-semibold">{plan.selected_clip.title}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {fmtTime(plan.selected_clip.start)} → {fmtTime(plan.selected_clip.end)} · {fmtDuration(plan.selected_clip.duration)}
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
            <PlanStat icon={<Scissors className="h-3 w-3" />} label="Cuts" value={plan.selected_clip.cuts.length} />
            <PlanStat icon={<Check className="h-3 w-3" />} label="Subtitles" value={plan.selected_clip.subtitles.length} />
            <PlanStat icon={<Wand2 className="h-3 w-3" />} label="Camera" value={plan.selected_clip.camera.length} />
            <PlanStat icon={<Sparkles className="h-3 w-3" />} label="Visuals" value={plan.selected_clip.visuals.length} />
          </div>

          {/* Honest capability labeling (Phase 14) */}
          <div className="mt-3 space-y-1.5 rounded-lg border border-sky-500/20 bg-sky-500/5 p-2.5 text-[10px] leading-relaxed">
            <p className="font-semibold text-sky-700 dark:text-sky-400">What the renderer actually applies to the MP4:</p>
            <p className="text-muted-foreground">
              ✅ Cuts (removed sections) · ✅ Subtitle burn-in (transcript-grounded, output-time mapped) · ✅ Karaoke word-highlight (when word timestamps are available) · ✅ Camera punch-in/zoom · ✅ 9:16 crop + scale · ✅ H.264 + AAC 1080×1920
            </p>
            <p className="font-semibold text-amber-600 dark:text-amber-400">Preview-only recommendations (NOT rendered into the MP4):</p>
            <p className="text-muted-foreground">
              ⚠️ B-roll / generated visuals · ⚠️ Animations · ⚠️ Sound effects · ⚠️ Music — these are AI suggestions for your editor; export the JSON plan to apply them in Premiere/Resolve.
            </p>
          </div>
        </div>
      )}

      {/* cover-frame picker ( Shorts cover = first impression; the extracted
          JPG comes from the RENDERED output at the chosen OUTPUT time — the
          preview canvas maps it via the same keep-range math) */}
      {plan && !emptyEdit && (
        <div className="rounded-lg border border-border/60 bg-card/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <ImageIcon className="h-3 w-3 text-primary" />
              Cover frame
              {coverT != null && (
                <Badge variant="outline" className="ml-1 border-primary/40 bg-primary/10 text-[9px] text-primary">
                  @ {fmtDuration(coverT)}
                </Badge>
              )}
            </div>
            {coverT != null ? (
              <button
                type="button"
                onClick={() => setCoverT(null)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            ) : (
              <span className="text-[10px] text-muted-foreground">optional</span>
            )}
          </div>

          <div className="flex gap-3">
            {/* 9:16 live preview — the EXACT frame the renderer will extract */}
            <div className="relative w-20 shrink-0 overflow-hidden rounded-md border border-border/60 bg-black" style={{ aspectRatio: '9 / 16' }}>
              {coverT != null && coverMediaUrl ? (
                <>
                  <canvas ref={coverCanvasRef} width={180} height={320} className="h-full w-full" aria-label="Cover frame preview" />
                  {coverSeeking && (
                    <div className="absolute inset-0 grid place-items-center bg-black/40">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-white/80" />
                    </div>
                  )}
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground/50">
                  <ImageIcon className="h-5 w-5" />
                  <span className="px-1 text-center text-[8px] leading-tight">
                    {coverMediaUrl ? 'drag to pick' : 'no preview source'}
                  </span>
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1 space-y-2">
              {coverMediaUrl ? (
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.1, outputDurationSec)}
                  step={0.1}
                  value={coverT ?? 0}
                  aria-label="Cover frame timestamp"
                  onChange={(e) => setCoverT(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              ) : (
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {sourceMode === 'local'
                    ? 'Frame preview needs the server source (or upload a file below) — you can still set the timestamp.'
                    : 'Frame preview needs a source — pick the server source or upload a file.'}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCoverT(0)}
                  className="rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  First frame
                </button>
                <button
                  type="button"
                  onClick={() => setCoverT(Math.round(outputDurationSec / 2 * 10) / 10)}
                  className="rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  Middle
                </button>
                <button
                  type="button"
                  onClick={() => setCoverT(Math.max(0, Math.round((outputDurationSec - 0.1) * 10) / 10))}
                  className="rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  Last frame
                </button>
                {coverT != null && (
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                    output {fmtDuration(coverT)}
                  </span>
                )}
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {coverT != null
                  ? 'Rendered with the plan — a JPG of this exact frame (after cuts, zoom & subtitles) is extracted for your Short\'s cover.'
                  : 'Pick the moment viewers see first in the Shorts feed. The cover is extracted from the rendered video — cuts, zoom and burned subtitles included.'}
              </p>
            </div>
          </div>

          {/* hidden seek source for the canvas (never displayed) */}
          {coverMediaUrl && coverT != null && (
            <video
              ref={coverVideoRef}
              src={coverMediaUrl}
              preload="metadata"
              muted
              playsInline
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
          )}
        </div>
      )}

      {/* render button */}
      {emptyEdit && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This edit cuts away the entire clip ({outputDurationSec.toFixed(1)}s of output would remain) — nothing to render.
            Reduce the cut ranges in the editor first.
          </span>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          onClick={startRender}
          disabled={!canRender || phase === 'rendering'}
          className="gap-2"
        >
          {phase === 'rendering' ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Rendering…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Render MP4 (9:16)
            </>
          )}
        </Button>
        {phase === 'rendering' && jobId && (
          <Button
            variant="outline"
            onClick={cancelRender}
            disabled={cancelling}
            className="gap-2 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
          >
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
        {file && phase !== 'rendering' && (
          <Button variant="ghost" onClick={reset} className="gap-2 text-muted-foreground">
            <X className="h-4 w-4" />
            Reset
          </Button>
        )}
      </div>

      {/* notice (cancel confirmations etc.) */}
      <AnimatePresence>
        {notice && !error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{notice}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* progress */}
      <AnimatePresence>
        {phase === 'rendering' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-2"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                {stage}
              </span>
              <span className="font-mono tabular-nums font-bold">{progress}%</span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
                className="h-full rounded-full bg-gradient-to-r from-primary/60 via-primary to-primary"
              />
              {/* shimmer overlay */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent shimmer" />
            </div>
            {/* elapsed + honest ETA (slope of real poll samples, shown once stable) */}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
              <span>elapsed {fmtClock(timing.elapsedMs)}</span>
              <span>
                {timing.etaMs != null ? (
                  <>≈ {fmtClock(timing.etaMs)} left</>
                ) : (
                  <span className="animate-pulse">estimating…</span>
                )}
              </span>
            </div>
            {/* stage steps — thresholds MATCH the renderer's real weights:
                queued 0 → prepare 8 → encode 25–92 (ffmpeg progress pipe) →
                finalize 95 → done 100. Labels renamed to what actually runs
                (single-pass trim+concat+filters; there is no separate concat stage). */}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              {((): { label: string; at: number }[] => [
                { label: sourceMode === 'local' ? 'Queue' : 'Upload', at: 0 },
                { label: 'Prepare', at: 8 },
                { label: 'Encode', at: 25 },
                { label: 'Finalize', at: 93 },
                { label: 'Done', at: 100 },
              ])().map((s, i, arr) => {
                const next = arr[i + 1]?.at ?? 101
                const active = progress >= s.at
                const current = progress < next
                return (
                  <span
                    key={s.label}
                    className={`flex items-center gap-1 ${
                      active ? 'text-primary' : 'text-muted-foreground/40'
                    }`}
                  >
                    {active && current ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : active ? (
                      <Check className="h-2.5 w-2.5" />
                    ) : (
                      <span className="h-2.5 w-2.5 rounded-full border border-current" />
                    )}
                    {s.label}
                  </span>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* result */}
      <AnimatePresence>
        {phase === 'done' && renderedUrl && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4"
          >
            <div className="flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
                <Check className="h-5 w-5" strokeWidth={3} />
              </div>
              <div>
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Render complete!</p>
                <p className="text-xs text-muted-foreground">
                  {renderedInfo && `${renderedInfo.width}×${renderedInfo.height} · ${fmtDuration(renderedInfo.duration)} · ${(renderedInfo.size / 1024 / 1024).toFixed(2)} MB`}
                  {timing.elapsedMs > 0 && ` · rendered in ${fmtClock(timing.elapsedMs)}`}
                </p>
              </div>
              {renderedInfo && !renderedInfo.durationOk && (
                <Badge variant="outline" className="ml-auto border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                  duration deviates from plan — verify cuts
                </Badge>
              )}
            </div>

            {/* video preview + cover thumbnail */}
            <div className="flex items-start gap-3">
              <div className="overflow-hidden rounded-lg bg-black">
                <video
                  src={renderedUrl}
                  controls
                  className="mx-auto max-h-[60vh] w-full"
                  style={{ aspectRatio: '9 / 16', maxWidth: 'calc(60vh * 9 / 16)' }}
                />
              </div>
              {hasCover && coverUrl && (
                <div className="w-20 shrink-0 space-y-1">
                  <img
                    src={coverUrl}
                    alt="Extracted cover frame"
                    className="w-full rounded-md border border-border/60"
                    style={{ aspectRatio: '9 / 16' }}
                  />
                  <p className="text-center text-[9px] text-muted-foreground">cover.jpg</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={downloadRendered} className="gap-2">
                <Download className="h-4 w-4" />
                Download MP4
              </Button>
              {hasCover && coverUrl && (
                <Button onClick={downloadCover} variant="outline" className="gap-2 border-primary/40">
                  <ImageIcon className="h-4 w-4" />
                  Download cover (JPG)
                </Button>
              )}
              <Button variant="outline" onClick={reset} className="gap-2">
                <UploadCloud className="h-4 w-4" />
                Render another
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function PlanStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div
      className="group flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2 py-1.5 transition-colors hover:border-primary/30 hover:bg-primary/5"
      title={`${value} ${label.toLowerCase()} in this edit plan`}
    >
      <span className="text-primary/80 transition-colors group-hover:text-primary">{icon}</span>
      <span className="text-sm font-bold tabular-nums leading-none">{value}</span>
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/80">{label}</span>
    </div>
  )
}

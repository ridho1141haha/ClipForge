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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { type EditPlan } from '@/lib/editplan'
import { buildRenderRecipe } from '@/lib/render-recipe'
import { fmtTime, fmtDuration } from '@/lib/youtube'

interface Props {
  plan: EditPlan | null
  // optional: when invoked from library with a stored clip plan
}

type Phase = 'idle' | 'uploading' | 'rendering' | 'done' | 'error'

export function UploadRender({ plan }: Props) {
  const [file, setFile] = React.useState<File | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [phase, setPhase] = React.useState<Phase>('idle')
  const [progress, setProgress] = React.useState(0)
  const [stage, setStage] = React.useState('')
  const [jobId, setJobId] = React.useState<string | null>(null)
  const [renderedUrl, setRenderedUrl] = React.useState<string | null>(null)
  const [renderedInfo, setRenderedInfo] = React.useState<{ size: number; duration: number; width: number; height: number } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const pollRef = React.useRef<number>(0)

  const canRender = !!file && !!plan

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
    if (!file || !plan) return
    setPhase('rendering')
    setProgress(0)
    setStage('Uploading…')
    setError(null)
    setRenderedUrl(null)
    setRenderedInfo(null)
    try {
      const recipe = buildRenderRecipe(plan, 'upload')
      const formData = new FormData()
      formData.append('video', file)
      formData.append('recipe', JSON.stringify(recipe))
      // Use Next.js API proxy to avoid CORS — proxies to localhost:3003
      const res = await fetch('/api/render-proxy/render', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setJobId(data.id)
      setStage('Queued…')
      pollJob(data.id)
    } catch (e: any) {
      setPhase('error')
      setError(e.message)
    }
  }

  const pollJob = (id: string) => {
    let stopped = false
    const poll = async () => {
      if (stopped) return
      try {
        const res = await fetch(`/api/render-proxy/jobs/${id}`)
        const job = await res.json()
        setProgress(job.progress ?? 0)
        setStage(job.stage ?? '')
        if (job.status === 'done') {
          setPhase('done')
          setRenderedInfo({
            size: job.size ?? 0,
            duration: job.duration ?? 0,
            width: job.width ?? 1080,
            height: job.height ?? 1920,
          })
          // fetch the rendered file
          const dlRes = await fetch(`/api/render-proxy/jobs/${id}/download`)
          const blob = await dlRes.blob()
          const url = URL.createObjectURL(blob)
          setRenderedUrl(url)
          return
        }
        if (job.status === 'error') {
          setPhase('error')
          setError(job.error ?? 'Render failed')
          return
        }
        pollRef.current = window.setTimeout(poll, 1000)
      } catch {
        pollRef.current = window.setTimeout(poll, 2000)
      }
    }
    poll()
    ;(pollJob as any).stop = () => { stopped = true; clearTimeout(pollRef.current) }
  }

  React.useEffect(() => {
    return () => {
      clearTimeout(pollRef.current)
      if (renderedUrl) URL.revokeObjectURL(renderedUrl)
    }
  }, [renderedUrl])

  const reset = () => {
    if (renderedUrl) URL.revokeObjectURL(renderedUrl)
    setFile(null)
    setPhase('idle')
    setProgress(0)
    setStage('')
    setJobId(null)
    setRenderedUrl(null)
    setRenderedInfo(null)
    setError(null)
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
            Upload your source video and we&apos;ll render it into a 9:16 MP4 with the AI edit plan applied — cuts, subtitles, camera zoom.
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

      {/* drop zone */}
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

      {/* plan summary */}
      {plan && (
        <div className="rounded-lg border border-border/60 bg-card/40 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            Edit plan to apply
          </div>
          <p className="text-sm font-semibold">{plan.selected_clip.title}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {fmtTime(plan.selected_clip.start)} → {fmtTime(plan.selected_clip.end)} · {fmtDuration(plan.selected_clip.duration)}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
            <PlanStat icon={<Scissors className="h-3 w-3" />} label="Cuts" value={plan.selected_clip.cuts.length} />
            <PlanStat icon={<Check className="h-3 w-3" />} label="Subtitles" value={plan.selected_clip.subtitles.length} />
            <PlanStat icon={<Wand2 className="h-3 w-3" />} label="Camera" value={plan.selected_clip.camera.length} />
            <PlanStat icon={<Sparkles className="h-3 w-3" />} label="Visuals" value={plan.selected_clip.visuals.length} />
          </div>

          {/* Honest capability labeling (Phase 14) */}
          <div className="mt-3 space-y-1.5 rounded-md border border-sky-500/20 bg-sky-500/5 p-2.5 text-[10px] leading-relaxed">
            <p className="font-semibold text-sky-700 dark:text-sky-400">What the renderer actually applies to the MP4:</p>
            <p className="text-muted-foreground">
              ✅ Cuts (removed sections) · ✅ Subtitle burn-in (transcript-grounded, output-time mapped) · ✅ Camera punch-in/zoom · ✅ 9:16 crop + scale · ✅ H.264 + AAC 1080×1920
            </p>
            <p className="font-semibold text-amber-600 dark:text-amber-400">Preview-only recommendations (NOT rendered into the MP4):</p>
            <p className="text-muted-foreground">
              ⚠️ B-roll / generated visuals · ⚠️ Animations · ⚠️ Sound effects · ⚠️ Music — these are AI suggestions for your editor; export the JSON plan to apply them in Premiere/Resolve.
            </p>
          </div>
        </div>
      )}

      {/* render button */}
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
        {file && phase !== 'rendering' && (
          <Button variant="ghost" onClick={reset} className="gap-2 text-muted-foreground">
            <X className="h-4 w-4" />
            Reset
          </Button>
        )}
      </div>

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
            {/* stage steps */}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              {['Upload', 'Extract', 'Concat', 'Encode', 'Done'].map((s, i) => {
                const thresholds = [0, 5, 35, 50, 100]
                const active = progress >= thresholds[i]
                const current = progress < (thresholds[i + 1] ?? 100)
                return (
                  <span
                    key={s}
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
                    {s}
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
                </p>
              </div>
            </div>

            {/* video preview */}
            <div className="overflow-hidden rounded-lg bg-black">
              <video
                src={renderedUrl}
                controls
                className="mx-auto max-h-[60vh] w-full"
                style={{ aspectRatio: '9 / 16', maxWidth: 'calc(60vh * 9 / 16)' }}
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={downloadRendered} className="gap-2">
                <Download className="h-4 w-4" />
                Download MP4
              </Button>
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
    <div className="flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1">
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  )
}

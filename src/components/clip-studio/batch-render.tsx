'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Layers,
  Play,
  Square,
  CircleCheck,
  CircleX,
  Loader2,
  Clock3,
  FileText,
  Film,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type EditPlan } from '@/lib/editplan'
import { buildRenderRecipe, buildRecipeJSON } from '@/lib/render-recipe'
import { outputDuration as planOutputDuration } from '@/lib/subtitles'
import { type Cut } from '@/lib/subtitles'
import { fmtDuration } from '@/lib/youtube'

// ---------------------------------------------------------------------------
// BatchRender — "render every approved clip" as a sequential pipeline.
//
// For each APPROVED clip that has a stored AI plan, the full edit plan is
// reconstructed from the clip's persisted fields (same mapping openPlanView
// uses) and rendered server-side (project source → render-proxy JSON mode).
// One render runs at a time (the renderer's FIFO queue also serializes; this
// loop additionally avoids holding N full source-file streams in memory).
// Approved clips WITHOUT a plan are listed honestly as "needs AI plan" and
// skipped — the renderer requires a recipe; nothing is invented.
// ---------------------------------------------------------------------------

interface ClipPlanSource {
  id: string
  title: string
  startTime: number
  endTime: number
  status?: string
  hasPlan?: boolean
  generatedHook?: string | null
  segments?: unknown
  cuts?: unknown
  camera?: unknown
  visuals?: unknown
  animations?: unknown
  soundEffects?: unknown
  music?: unknown
  subtitles?: unknown
}

type BatchStatus = 'ready' | 'needs-plan' | 'queued' | 'rendering' | 'done' | 'failed' | 'skipped'

interface Props {
  clips: ClipPlanSource[]
  platform: string
  style: string
  targetDuration: number
  projectId: string | null
  /** render uses the server-side source — required for batch */
  localReady: boolean
  onJobStarted?: (jobId: string) => void
  /** open the studio scroll target so users can generate the missing plans */
  onOpenStudio?: () => void
}

function planFromClip(c: ClipPlanSource, platform: string, style: string, targetDuration: number): EditPlan {
  return {
    project: { title: c.title, style, platform, target_duration: targetDuration, aspect_ratio: '9:16' },
    analysis: { main_topic: '', audience: '', content_type: '', overall_summary: '' },
    selected_clip: {
      id: c.id,
      start: c.startTime,
      end: c.endTime,
      duration: +(c.endTime - c.startTime).toFixed(1),
      title: c.title,
      generated_hook: c.generatedHook ?? '',
      segments: c.segments as EditPlan['selected_clip']['segments'],
      // Clip.cuts is persisted JSON (optional reason per stored cut); the
      // EditPlan recipe path expects a reason — normalize honestly per cut
      cuts: ((c.cuts as Cut[] | undefined) ?? []).map((cut) => ({
        start: cut.start,
        end: cut.end,
        reason: cut.reason ?? '',
      })) as EditPlan['selected_clip']['cuts'],
      camera: c.camera as EditPlan['selected_clip']['camera'],
      visuals: c.visuals as EditPlan['selected_clip']['visuals'],
      animations: c.animations as EditPlan['selected_clip']['animations'],
      sound_effects: c.soundEffects as EditPlan['selected_clip']['sound_effects'],
      music: c.music as EditPlan['selected_clip']['music'],
      subtitles: c.subtitles as EditPlan['selected_clip']['subtitles'],
    },
  }
}

export function BatchRender({ clips, platform, style, targetDuration, projectId, localReady, onJobStarted, onOpenStudio }: Props) {
  // per-clip batch status keyed by clip id
  const [statusMap, setStatusMap] = React.useState<Map<string, BatchStatus>>(new Map())
  const [progressMap, setProgressMap] = React.useState<Map<string, number>>(new Map())
  const [errorMap, setErrorMap] = React.useState<Map<string, string>>(new Map())
  const [running, setRunning] = React.useState(false)
  const stopRef = React.useRef(false)

  const approved = React.useMemo(() => clips.filter((c) => c.status === 'approved'), [clips])
  const renderable = approved.filter((c) => c.hasPlan && c.segments)
  const needsPlan = approved.filter((c) => !(c.hasPlan && c.segments))
  const doneCount = approved.filter((c) => statusMap.get(c.id) === 'done').length
  const failedCount = approved.filter((c) => statusMap.get(c.id) === 'failed').length

  const canStart =
    localReady && renderable.length > 0 && !running && projectId != null

  const startBatch = async () => {
    if (!canStart) return
    stopRef.current = false
    setRunning(true)
    setStatusMap(new Map(renderable.map((c) => [c.id, 'queued' as BatchStatus])))
    setProgressMap(new Map())
    setErrorMap(new Map())
    try {
      for (const c of renderable) {
        if (stopRef.current) {
          // mark every not-yet-processed clip as skipped
          setStatusMap((m) => {
            const next = new Map(m)
            for (const r of renderable) if (next.get(r.id) === 'queued') next.set(r.id, 'skipped')
            return next
          })
          break
        }
        const plan = planFromClip(c, platform, style, targetDuration)
        const recipeJson = buildRecipeJSON(buildRenderRecipe(plan, 'server'), {})
        setStatusMap((m) => new Map(m).set(c.id, 'rendering'))
        setProgressMap((m) => new Map(m).set(c.id, 0))
        try {
          const res = await fetch('/api/render-proxy/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipe: recipeJson, projectId }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? 'Render request failed')
          onJobStarted?.(data.id)
          // poll until terminal
          let terminal = false
          while (!terminal && !stopRef.current) {
            await new Promise((r) => setTimeout(r, 3000))
            const jr = await fetch(`/api/render-proxy/jobs/${data.id}`, { cache: 'no-store' })
            if (!jr.ok) {
              // 404 = lost/expired job — honest failure for this clip
              throw new Error('Render job lost — the render service may have restarted. Try again.')
            }
            const job = await jr.json()
            setProgressMap((m) => new Map(m).set(c.id, job.progress ?? 0))
            if (job.status === 'done') {
              setStatusMap((m) => new Map(m).set(c.id, 'done'))
              terminal = true
            } else if (job.status === 'error') {
              throw new Error(job.error ?? job.stage ?? 'Render failed')
            } else if (job.status === 'cancelled') {
              setStatusMap((m) => new Map(m).set(c.id, 'skipped'))
              terminal = true
            }
          }
          if (stopRef.current && !terminal) {
            // user pressed stop mid-render: cancel the live job, mark skipped
            try {
              await fetch(`/api/render-proxy/jobs/${data.id}/cancel`, { method: 'POST' })
            } catch { /* best-effort */ }
            setStatusMap((m) => new Map(m).set(c.id, 'skipped'))
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          setStatusMap((m) => new Map(m).set(c.id, 'failed'))
          setErrorMap((m) => new Map(m).set(c.id, msg))
        }
      }
    } finally {
      setRunning(false)
      stopRef.current = false
    }
  }

  const stopBatch = () => {
    stopRef.current = true
  }

  // nothing approved at all → hide the whole card
  if (approved.length === 0) return null

  const statusIcon = (s: BatchStatus | undefined, progress: number | undefined) => {
    switch (s) {
      case 'done':
        return <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />
      case 'failed':
        return <CircleX className="h-3.5 w-3.5 text-rose-500" />
      case 'rendering':
        return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
      case 'queued':
        return <Clock3 className="h-3.5 w-3.5 text-amber-500/70" />
      case 'skipped':
        return <Square className="h-3 w-3 text-muted-foreground/50" />
      case 'needs-plan':
        return <FileText className="h-3.5 w-3.5 text-muted-foreground/60" />
      default:
        return <Film className="h-3.5 w-3.5 text-muted-foreground/60" />
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card/50 p-4 sm:p-5">
      {/* top hairline gradient accent */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />

      {/* header */}
      <div className="mb-3.5 flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
          <Layers className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-sm font-semibold">Batch render</h3>
        <span className="hidden items-center gap-1 text-[10px] font-medium text-muted-foreground sm:inline-flex">
          {running ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                </span>
                working
              </span>
              <span className="tabular-nums font-semibold text-foreground/70">{doneCount}</span>
              <span>/ {renderable.length} done</span>
            </>
          ) : (
            <>
              <span className="tabular-nums font-semibold text-foreground/70">{renderable.length}</span>
              <span>approved{renderable.length === 1 ? ' clip' : ' clips'} ready</span>
              {needsPlan.length > 0 ? (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="tabular-nums">{needsPlan.length} need{needsPlan.length === 1 ? 's' : ''} AI plan</span>
                </>
              ) : null}
              {failedCount > 0 ? (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="tabular-nums text-rose-500">{failedCount} failed</span>
                </>
              ) : null}
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={stopBatch} className="h-8 gap-1.5 border-border/60 text-[11px]">
              <Square className="h-3 w-3" />
              Stop batch
            </Button>
          ) : (
            <Button size="sm" onClick={startBatch} disabled={!canStart} className="h-8 gap-1.5 text-[11px]">
              <Play className="h-3 w-3" />
              {renderable.length > 1 ? `Render ${renderable.length} clips` : 'Render clip'}
            </Button>
          )}
        </div>
      </div>

      {/* prerequisite notice */}
      {!localReady ? (
        <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          Batch render needs the server-side source video — it appears after a URL analysis (auto-downloaded) or an upload.
        </p>
      ) : null}

      {/* clip list */}
      <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
        <AnimatePresence initial={false}>
          {approved.map((c, i) => {
            const st: BatchStatus | undefined = statusMap.get(c.id) ?? (c.hasPlan && c.segments ? undefined : 'needs-plan')
            const prog = progressMap.get(c.id) ?? 0
            const err = errorMap.get(c.id)
            const isLive = st === 'rendering' || st === 'queued'
            return (
              <motion.li
                key={c.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, delay: Math.min(i * 0.02, 0.1) }}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                  st === 'done'
                    ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                    : st === 'failed'
                      ? 'border-rose-500/20 bg-rose-500/[0.04]'
                      : isLive
                        ? 'border-amber-500/25 bg-amber-500/[0.04]'
                        : 'border-border/50 bg-background/40'
                }`}
              >
                <span className="shrink-0">{statusIcon(st, prog)}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={c.title}>
                  {c.title}
                </span>
                <span className="flex shrink-0 items-center justify-end gap-1.5 text-right">
                  <span className="w-9 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                    {fmtDuration(c.endTime - c.startTime)}
                  </span>
                  {st === 'needs-plan' ? (
                    <button
                      onClick={onOpenStudio}
                      className="inline-flex min-w-[70px] items-center justify-center rounded-md border border-border/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                      title="Open the studio and generate an AI plan for this clip first"
                    >
                      needs plan
                    </button>
                  ) : st === 'rendering' ? (
                    <span className="inline-flex min-w-[70px] items-center justify-center tabular-nums text-[10px] font-semibold text-amber-600 dark:text-amber-400">{Math.round(prog)}%</span>
                  ) : st === 'done' ? (
                    <span className="inline-flex min-w-[70px] items-center justify-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                      <CircleCheck className="h-3 w-3" />
                      rendered
                    </span>
                  ) : st === 'failed' ? (
                    <span className="inline-flex min-w-[70px] items-center justify-center text-[10px] font-semibold text-rose-500">failed</span>
                  ) : st === 'skipped' ? (
                    <span className="inline-flex min-w-[70px] items-center justify-center text-[10px] text-muted-foreground/60">skipped</span>
                  ) : (
                    <span className="inline-flex min-w-[70px] items-center justify-center text-[10px] text-muted-foreground/50">ready</span>
                  )}
                </span>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>

      {/* last error detail */}
      {failedCount > 0 ? (
        <div className="mt-2.5 space-y-1 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-2 text-[10px] leading-relaxed">
          {approved
            .filter((c) => statusMap.get(c.id) === 'failed')
            .slice(0, 2)
            .map((c) => (
              <p key={c.id} className="flex items-start gap-1.5 text-rose-600 dark:text-rose-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="line-clamp-2">
                  <strong>{c.title.slice(0, 40)}:</strong> {errorMap.get(c.id) ?? 'render failed'}
                </span>
              </p>
            ))}
        </div>
      ) : null}

      <p className="mt-2.5 flex items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
        <Clock3 className="h-3 w-3 shrink-0" />
        Renders run one at a time from the server source. Finished MP4s land in the render history below (stored on the server; oldest auto-cleaned under the storage cap).
      </p>
    </div>
  )
}

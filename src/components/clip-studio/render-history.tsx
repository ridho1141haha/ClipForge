'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  History,
  RefreshCw,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock3,
  Film,
  AlertTriangle,
  RotateCcw,
  MonitorPlay,
  Image as ImageIcon,
  Server,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// RenderHistory — owner-scoped list of past render jobs (RenderJob table),
// reconciled against the live renderer by the proxy on every fetch:
//   • live progress for ACTIVE jobs (poll while any is running)
//   • honest "job lost" rows after a renderer restart (re-render hint)
//   • download links for DONE jobs (artifacts live in the persisted store —
//     upload/renders — until the oldest are GC'd under the storage cap)
//   • finished-artifact facts (filename · size · duration · cover availability)
//   • queue-depth chip ("1 rendering · N in line") from the renderer /stats
// Completion TOASTS are handled by the page-level RenderNotifier — this panel
// is display + polling only (no double-notification).
// ---------------------------------------------------------------------------

interface RenderJobRow {
  id: string
  status: 'QUEUED' | 'EXTRACTING' | 'RENDERING' | 'FINALIZING' | 'DONE' | 'ERROR' | 'CANCELLED' | string
  stage: string | null
  filename: string | null
  projectId: string | null
  // live/persisted facts merged by the proxy from the renderer (manifest
  // fallback keeps these answered after the in-memory registry is reaped;
  // absent only once the artifact is GC'd or the renderer is unreachable)
  size?: number
  duration?: number
  hasCover?: boolean
  downloadable?: boolean
  createdAt: string
  updatedAt: string
}

interface QueueInfo {
  waiting: number
  busy: boolean
}

const ACTIVE: string[] = ['QUEUED', 'EXTRACTING', 'RENDERING', 'FINALIZING']

function statusVisual(status: string) {
  switch (status) {
    case 'DONE':
      return {
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        label: 'Done',
      }
    case 'ERROR':
      return {
        icon: <XCircle className="h-3.5 w-3.5" />,
        cls: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
        label: 'Failed',
      }
    case 'CANCELLED':
      return {
        icon: <XCircle className="h-3.5 w-3.5" />,
        cls: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
        label: 'Cancelled',
      }
    default:
      return {
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
        cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        label: status.charAt(0) + status.slice(1).toLowerCase(),
      }
  }
}

function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

export function RenderHistory({ refreshKey }: { refreshKey?: number }) {
  const [jobs, setJobs] = React.useState<RenderJobRow[] | null>(null)
  const [queue, setQueue] = React.useState<QueueInfo | null>(null)
  const [loading, setLoading] = React.useState(false)
  const timerRef = React.useRef<number>(0)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/render-proxy/jobs', { cache: 'no-store' })
      if (res.ok) {
        const data = (await res.json()) as { jobs?: RenderJobRow[]; queue?: QueueInfo | null }
        setJobs(data.jobs ?? [])
        setQueue(data.queue ?? null)
      } else {
        setJobs([])
      }
    } catch {
      // network hiccup — keep the previous list, the next poll will retry
    } finally {
      setLoading(false)
    }
  }, [])

  // initial load + reload when a new render starts (refreshKey bump)
  React.useEffect(() => {
    void load()
  }, [load, refreshKey])

  // live polling while ANY job is active (renderer progress is real);
  // slow heartbeat otherwise just to catch reconciliation changes
  React.useEffect(() => {
    const anyActive = jobs?.some((j) => ACTIVE.includes(j.status)) ?? false
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => void load(), anyActive ? 4000 : 30_000)
    return () => window.clearTimeout(timerRef.current)
  }, [jobs, load])

  const anyActive = jobs?.some((j) => ACTIVE.includes(j.status)) ?? false
  const doneCount = jobs?.filter((j) => j.status === 'DONE').length ?? 0
  const queueBusy = queue != null && (queue.busy || queue.waiting > 0)

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card/50 p-4 sm:p-5">
      {/* top hairline gradient — ties the panel to the app's accent language */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />

      {/* header */}
      <div className="mb-3.5 flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
          <History className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-sm font-semibold">Render history</h3>
        {anyActive ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
            </span>
            live
          </span>
        ) : null}
        {/* queue depth — includes OTHER sessions' jobs (single serial queue) */}
        {queueBusy && queue ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
            title={`The render queue runs one job at a time — ${queue.busy ? '1 rendering' : 'idle'}${queue.waiting > 0 ? ` · ${queue.waiting} waiting` : ''}`}
          >
            <Server className="h-2.5 w-2.5" />
            {queue.busy ? '1 rendering' : 'busy'}
            {queue.waiting > 0 ? ` · ${queue.waiting} in line` : ''}
          </span>
        ) : null}
        <span className="ml-auto hidden items-center gap-1 text-[10px] font-medium text-muted-foreground sm:inline-flex">
          {jobs && jobs.length > 0 ? (
            <>
              <span className="tabular-nums font-semibold text-foreground/70">{doneCount}</span>
              <span>done</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="tabular-nums font-semibold text-foreground/70">{jobs.length}</span>
              <span>total</span>
            </>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label="Refresh render history"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* list */}
      {jobs === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading your renders…
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <div className="rounded-full border border-border/60 bg-muted/40 p-3">
            <MonitorPlay className="h-5 w-5 text-muted-foreground/70" />
          </div>
          <p className="text-xs font-medium text-muted-foreground">No renders yet</p>
          <p className="max-w-[240px] text-[11px] leading-relaxed text-muted-foreground/70">
            Render a clip above — finished jobs appear here with download links.
          </p>
        </div>
      ) : (
        <ul className="max-h-72 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
          <AnimatePresence initial={false}>
            {jobs.map((job, i) => {
              const v = statusVisual(job.status)
              const active = ACTIVE.includes(job.status)
              const lost = job.status === 'ERROR' && (job.stage ?? '').includes('lost')
              return (
                <motion.li
                  key={job.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(i * 0.03, 0.15) }}
                  className={`group rounded-lg border p-3 transition-all hover:shadow-sm ${
                    active
                      ? 'border-amber-500/25 bg-amber-500/[0.04] hover:border-amber-500/40'
                      : job.status === 'DONE'
                        ? 'border-emerald-500/15 bg-emerald-500/[0.03] hover:border-emerald-500/30'
                        : 'border-border/50 bg-background/40 hover:border-border'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {/* cover thumbnail — the exact frame picked in the cover
                        selector, streamed through the ownership-gated proxy
                        (?inline=1: browsers refuse <img> with attachment
                        disposition) */}
                    {job.status === 'DONE' && job.downloadable && job.hasCover ? (
                      <img
                        src={`/api/render-proxy/jobs/${job.id}/cover?inline=1`}
                        alt=""
                        loading="lazy"
                        width={24}
                        height={42}
                        className="h-[42px] w-6 shrink-0 rounded-[3px] border border-border/60 bg-muted object-cover"
                      />
                    ) : null}

                    {/* status chip */}
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${v.cls}`}
                    >
                      {v.icon}
                      {v.label}
                    </span>

                    {/* name */}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium" title={job.filename ?? job.id}>
                      {job.filename ?? `Render ${job.id.slice(0, 8)}`}
                    </span>

                    {/* time */}
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground/80">
                      <Clock3 className="h-3 w-3" />
                      {fmtAgo(job.createdAt)}
                    </span>

                    {/* cover download */}
                    {job.status === 'DONE' && job.downloadable && job.hasCover ? (
                      <a
                        href={`/api/render-proxy/jobs/${job.id}/cover`}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 bg-background/60 px-2 text-[11px] font-semibold text-muted-foreground transition-all hover:border-primary/40 hover:text-primary"
                        title="Download the extracted cover-frame JPG"
                      >
                        <ImageIcon className="h-3 w-3" />
                        <span className="hidden sm:inline">Cover</span>
                      </a>
                    ) : null}

                    {/* mp4 download */}
                    {job.status === 'DONE' && job.downloadable ? (
                      <a
                        href={`/api/render-proxy/jobs/${job.id}/download`}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] font-semibold text-emerald-600 transition-all hover:bg-emerald-500/20 hover:shadow-sm dark:text-emerald-400"
                        title="Download the rendered MP4 (stored on the server)"
                      >
                        <Download className="h-3 w-3" />
                        <span className="hidden sm:inline">MP4</span>
                      </a>
                    ) : job.status === 'DONE' && !job.downloadable ? (
                      <span
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/40 px-2 text-[10px] font-medium text-muted-foreground/60"
                        title="The rendered file was cleaned from the server's storage cap — render again to produce a fresh copy"
                      >
                        <Clock3 className="h-3 w-3" />
                        cleaned
                      </span>
                    ) : null}
                  </div>

                  {/* artifact facts */}
                  {job.status === 'DONE' && (job.size != null || job.duration != null) ? (
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Film className="h-3 w-3 text-emerald-500/70" />
                        <span className="font-semibold tabular-nums text-foreground/70">
                          {job.duration != null ? `${job.duration.toFixed(1)}s` : '—'}
                        </span>
                      </span>
                      {job.size != null ? <span className="tabular-nums">{fmtBytes(job.size)}</span> : null}
                      <span className="rounded bg-emerald-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                        1080×1920 · H.264 + AAC
                      </span>
                    </p>
                  ) : null}

                  {/* stage / error line */}
                  {(active || job.status === 'ERROR' || job.status === 'CANCELLED') && job.stage ? (
                    <p
                      className={`mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed ${
                        job.status === 'ERROR' ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'
                      }`}
                    >
                      {job.status === 'ERROR' ? (
                        lost ? (
                          <RotateCcw className="mt-0.5 h-3 w-3 shrink-0" />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        )
                      ) : (
                        <Film className="mt-0.5 h-3 w-3 shrink-0" />
                      )}
                      <span className="line-clamp-2">{job.stage}</span>
                    </p>
                  ) : null}

                  {/* active shimmer bar */}
                  {active ? (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                      <motion.div
                        className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-amber-500/70 to-transparent"
                        animate={{ x: ['-100%', '300%'] }}
                        transition={{ repeat: Infinity, duration: 1.4, ease: 'linear' }}
                      />
                    </div>
                  ) : null}
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      )}

      {jobs && jobs.length > 0 ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
          <Server className="h-3 w-3 shrink-0" />
          Rendered files are stored on the server — the oldest are auto-cleaned to stay under the storage cap.
          {anyActive ? ' Live progress updates every few seconds.' : ''}
        </p>
      ) : null}
    </div>
  )
}

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
  Trash2,
  Pin,
  PinOff,
  FolderDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'

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
  width?: number
  height?: number
  quality?: string
  /** true when the artifact is pinned (GC-exempt) — merged from the renderer
   *  manifest, so it survives restarts and registry reaping */
  pinned?: boolean
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
  const { toast } = useToast()
  const [jobs, setJobs] = React.useState<RenderJobRow[] | null>(null)
  const [queue, setQueue] = React.useState<QueueInfo | null>(null)
  const [loading, setLoading] = React.useState(false)
  const timerRef = React.useRef<number>(0)
  // ---- per-row delete state: two-tap inline confirm (mobile-friendly, no
  // modal). confirmId = row awaiting the second tap; deletingId = in-flight. ----
  const [confirmId, setConfirmId] = React.useState<string | null>(null)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const confirmResetRef = React.useRef<number>(0)
  // in-flight pin toggles (row id → target state) for per-row spinner/disabled
  const [pinningId, setPinningId] = React.useState<string | null>(null)

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
  // slow heartbeat otherwise just to catch reconciliation changes.
  // PAUSED while the browser tab is hidden (document.visibilityState) —
  // a hidden tab's 4s polls are pure waste; on return we reload at once.
  React.useEffect(() => {
    const anyActive = jobs?.some((j) => ACTIVE.includes(j.status)) ?? false
    window.clearTimeout(timerRef.current)
    if (typeof document !== 'undefined' && document.hidden) return // resumed by the visibility listener
    timerRef.current = window.setTimeout(() => void load(), anyActive ? 4000 : 30_000)
    return () => window.clearTimeout(timerRef.current)
  }, [jobs, load])

  // visibility-aware resume: immediate refresh when the tab comes back
  React.useEffect(() => {
    const onVis = () => {
      if (!document.hidden) {
        window.clearTimeout(timerRef.current)
        void load()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [load])

  // ---- delete a finished render + its stored artifacts ----
  const deleteJob = async (id: string) => {
    if (deletingId) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/render-proxy/jobs/${id}`, { method: 'DELETE' })
      const data = (await res.json().catch(() => ({}))) as { deleted?: boolean; error?: string }
      if (!res.ok || !data.deleted) {
        throw new Error(data.error ?? `Delete failed (HTTP ${res.status})`)
      }
      // optimistic removal — the row, its artifact, and its downloads are gone
      setJobs((prev) => (prev ? prev.filter((j) => j.id !== id) : prev))
      toast({
        title: 'Render deleted',
        description: 'The MP4, cover, and history row were removed from the server.',
      })
    } catch (e: unknown) {
      toast({
        title: 'Could not delete render',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
      setConfirmId((c) => (c === id ? null : c))
    }
  }

  const armConfirm = (id: string) => {
    window.clearTimeout(confirmResetRef.current)
    setConfirmId(id)
    // auto-disarm after 4s so a stray click never leaves a row “armed”
    confirmResetRef.current = window.setTimeout(() => {
      setConfirmId((c) => (c === id ? null : c))
    }, 4000)
  }

  // ---- pin/unpin a finished render (GC exemption) ----
  // Pinned artifacts are never evicted by the storage-cap sweep; unpinning
  // restores normal oldest-first eligibility. Optimistic toggle; a failure
  // reverts and toasts.
  const togglePin = async (id: string, next: boolean) => {
    if (pinningId) return
    setPinningId(id)
    setJobs((prev) =>
      prev ? prev.map((j) => (j.id === id ? { ...j, pinned: next } : j)) : prev,
    )
    try {
      const res = await fetch(`/api/render-proxy/jobs/${id}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      })
      const data = (await res.json().catch(() => ({}))) as { pinned?: boolean; error?: string }
      if (!res.ok || data.pinned !== next) {
        throw new Error(data.error ?? `Pin failed (HTTP ${res.status})`)
      }
      // server-confirmed state (also corrects an optimistic drift)
      setJobs((prev) =>
        prev ? prev.map((j) => (j.id === id ? { ...j, pinned: data.pinned } : j)) : prev,
      )
    } catch (e: unknown) {
      setJobs((prev) =>
        prev ? prev.map((j) => (j.id === id ? { ...j, pinned: !next } : j)) : prev,
      )
      toast({
        title: next ? 'Could not pin render' : 'Could not unpin render',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setPinningId(null)
    }
  }

  React.useEffect(() => () => window.clearTimeout(confirmResetRef.current), [])

  const anyActive = jobs?.some((j) => ACTIVE.includes(j.status)) ?? false
  const doneCount = jobs?.filter((j) => j.status === 'DONE').length ?? 0
  const queueBusy = queue != null && (queue.busy || queue.waiting > 0)
  // downloadable DONE rows with live facts — the archive ZIP includes exactly
  // these (manifest-validated server-side)
  const downloadableRows = jobs?.filter((j) => j.status === 'DONE' && j.downloadable) ?? []
  // pinned-storage soft warning threshold: pinned files NEVER auto-clean, so
  // a large pinned total deserves a gentle heads-up (disk is finite)
  const PINNED_WARN_BYTES = 500 * 1024 * 1024
  const pinnedBytes = jobs?.filter((j) => j.pinned && j.size != null).reduce((s, j) => s + (j.size ?? 0), 0) ?? 0
  const pinnedCount = jobs?.filter((j) => j.pinned).length ?? 0

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
        {/* download all — bulk ZIP of every still-stored render (hidden until
            2+ downloadable artifacts exist; the endpoint 404s honestly when
            everything has been cleaned) */}
        {downloadableRows.length >= 2 ? (
          <a
            href="/api/render-proxy/archive"
            download
            className="relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] font-semibold text-emerald-600 transition-all after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:bg-emerald-500/20 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:text-emerald-400"
            title={`Download all ${downloadableRows.length} stored renders as one ZIP file`}
            aria-label={`Download all ${downloadableRows.length} stored renders as ZIP`}
          >
            <FolderDown className="h-3 w-3" />
            <span className="hidden sm:inline">All ({downloadableRows.length})</span>
          </a>
        ) : null}
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
        <div className="flex flex-col items-center gap-2.5 py-10 text-center">
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
                      : job.status === 'DONE' && job.pinned
                        ? 'border-amber-500/25 bg-amber-500/[0.04] hover:border-amber-500/45'
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

                    {/* pin — DONE + downloadable rows only (pinning a cleaned
                        artifact is meaningless; active rows wait). Pinned rows
                        get the amber treatment + filled pin. */}
                    {job.status === 'DONE' && job.downloadable ? (
                      <button
                        type="button"
                        onClick={() => void togglePin(job.id, !job.pinned)}
                        disabled={pinningId === job.id}
                        aria-pressed={job.pinned === true}
                        aria-label={job.pinned ? `Unpin render ${job.filename ?? job.id.slice(0, 8)}` : `Pin render ${job.filename ?? job.id.slice(0, 8)}`}
                        title={
                          job.pinned
                            ? 'Pinned — kept until you delete it (click to unpin)'
                            : 'Pin — keep this render safe from automatic storage cleanup'
                        }
                        className={`relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:opacity-100 after:absolute after:-inset-2 after:content-[''] ${
                          job.pinned
                            ? 'border-amber-500/40 bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 hover:shadow-sm dark:text-amber-400'
                            : 'border-transparent text-muted-foreground/50 hover:border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-500 sm:opacity-0 sm:group-hover:opacity-100'
                        } ${pinningId === job.id ? 'sm:opacity-100' : ''}`}
                      >
                        {pinningId === job.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : job.pinned ? (
                          <Pin className="h-3.5 w-3.5" />
                        ) : (
                          <PinOff className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : null}

                    {/* cover download */}
                    {job.status === 'DONE' && job.downloadable && job.hasCover ? (
                      <a
                        href={`/api/render-proxy/jobs/${job.id}/cover`}
                        className="relative inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 bg-background/60 px-2 text-[11px] font-semibold text-muted-foreground transition-all after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:border-primary/40 hover:text-primary"
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
                        className="relative inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] font-semibold text-emerald-600 transition-all after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:bg-emerald-500/20 hover:shadow-sm dark:text-emerald-400"
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

                    {/* delete — terminal rows only (active rows must cancel
                        first). Two-tap inline confirm, auto-disarms after 4s. */}
                    {!active ? (
                      confirmId === job.id ? (
                        <span className="inline-flex shrink-0 items-center gap-1" role="group" aria-label="Confirm delete">
                          <button
                            type="button"
                            onClick={() => void deleteJob(job.id)}
                            disabled={deletingId === job.id}
                            className="relative inline-flex h-7 items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 text-[11px] font-semibold text-rose-600 transition-all after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:bg-rose-500/20 hover:shadow-sm dark:text-rose-400"
                            title="Permanently delete this render and its stored files"
                          >
                            {deletingId === job.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              window.clearTimeout(confirmResetRef.current)
                              setConfirmId(null)
                            }}
                            className="relative inline-flex h-7 items-center rounded-md border border-border/50 px-2 text-[11px] font-medium text-muted-foreground transition-all after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:text-foreground"
                            title="Keep this render"
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => armConfirm(job.id)}
                          disabled={deletingId != null}
                          className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground/50 transition-all after:absolute after:-inset-2 after:content-[''] hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-500 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                          aria-label={`Delete render ${job.filename ?? job.id.slice(0, 8)}`}
                          title="Delete this render (files + history row)"
                        >
                          {deletingId === job.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )
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
                        {job.width != null && job.height != null ? `${job.width}×${job.height}` : '1080×1920'} · H.264 + AAC
                      </span>
                      {job.quality && job.quality !== 'standard' ? (
                        <span className="rounded bg-primary/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-primary">
                          {job.quality}
                        </span>
                      ) : null}
                      {job.pinned ? (
                        <span
                          className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                          title="Pinned — kept until you delete it (exempt from automatic storage cleanup)"
                        >
                          <Pin className="h-2.5 w-2.5" />
                          pinned
                        </span>
                      ) : null}
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

      {/* pinned-storage soft warning — pinned files are exempt from the GC,
          so a growing pinned total is the one retention number users should
          consciously watch (round-5 worklog risk #2) */}
      {pinnedBytes > PINNED_WARN_BYTES ? (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {pinnedCount} pinned {pinnedCount === 1 ? 'render holds' : 'renders hold'}{' '}
            <strong className="tabular-nums font-semibold">{fmtBytes(pinnedBytes)}</strong> that never auto-cleans — delete
            some pins if you want to free server storage.
          </span>
        </p>
      ) : null}

      {jobs && jobs.length > 0 ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
          <Server className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">
            Pinned renders stay until you delete them — the oldest unpinned files auto-clean to stay under the storage cap.
            {anyActive ? ' Live progress updates every few seconds.' : ''}
          </span>
        </p>
      ) : null}
    </div>
  )
}

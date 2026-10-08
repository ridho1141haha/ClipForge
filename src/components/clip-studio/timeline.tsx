'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Maximize2, Minimize2, Scan } from 'lucide-react'
import { fmtTime, type SuggestedClip } from '@/lib/youtube'
import { snapToWordBoundary, buildSpeechStrip, type WordT } from '@/lib/word-snap'

interface Props {
  clips: SuggestedClip[]
  duration: number
  selectedId?: string | null
  onSelect?: (idx: number) => void
  onTrimStart?: (idx: number, newStart: number) => void
  onTrimEnd?: (idx: number, newEnd: number) => void
  playStart?: number | null
  /** snap trim handles to real word boundaries (needs clipWords on clips) */
  snapToSpeech?: boolean
}

export function Timeline({
  clips,
  duration,
  selectedId,
  onSelect,
  onTrimStart,
  onTrimEnd,
  playStart,
  snapToSpeech = true,
}: Props) {
  const ref = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const total = Math.max(duration, 1)
  // zoom expands the track into a horizontally scrollable surface (1x–4x)
  const [zoom, setZoom] = React.useState(1)
  const [drag, setDrag] = React.useState<
    | { type: 'start' | 'end'; idx: number; startMouseX: number; orig: number }
    | null
  >(null)
  const [snapHint, setSnapHint] = React.useState<string | null>(null)

  // Build tick marks (scaled by zoom)
  const tickCount = 6 * zoom
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (i / tickCount) * total)

  // speech density strip from ALL clip words (real word timestamps when grounded)
  const speechStrip = React.useMemo(() => {
    const words: WordT[] = clips.flatMap((c) => (c.clipWords ?? []).filter((w) => isFinite(w.start) && isFinite(w.end)))
    return buildSpeechStrip(words, total, 160)
  }, [clips, total])
  const hasSpeech = speechStrip.some((v) => v > 0)

  const pxToTime = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    return (x / rect.width) * total
  }

  const snap = React.useCallback(
    (t: number, idx: number): number => {
      if (!snapToSpeech) return t
      const clip = clips[idx]
      const words = clip?.clipWords?.filter((w) => isFinite(w.start) && isFinite(w.end)) ?? []
      if (words.length < 2) return t
      const snapped = snapToWordBoundary(t, words)
      return snapped.word ? snapped.time : t
    },
    [snapToSpeech, clips],
  )

  React.useEffect(() => {
    if (!drag) {
      setSnapHint(null)
      return
    }
    const handleMove = (e: MouseEvent) => {
      const dt = pxToTime(e.clientX)
      const clip = clips[drag.idx]
      if (!clip) return
      if (drag.type === 'start') {
        const raw = Math.max(0, Math.min(clip.endTime - 1, dt))
        const ns = snap(raw, drag.idx)
        const words = clip.clipWords ?? []
        const hit = snapToSpeech && words.length >= 2 ? snapToWordBoundary(raw, words) : null
        setSnapHint(hit?.word ? `start → speech: "${hit.word}"` : null)
        onTrimStart?.(drag.idx, ns)
      } else {
        const raw = Math.max(clip.startTime + 1, Math.min(total, dt))
        const ne = snap(raw, drag.idx)
        const words = clip.clipWords ?? []
        const hit = snapToSpeech && words.length >= 2 ? snapToWordBoundary(raw, words) : null
        setSnapHint(hit?.word ? `end → speech: "${hit.word}"` : null)
        onTrimEnd?.(drag.idx, ne)
      }
    }
    const handleUp = () => setDrag(null)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ew-resize'
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [drag, clips, total, onTrimStart, onTrimEnd, snap, snapToSpeech])

  const trackInner = (
    <div
      ref={ref}
      className="relative h-16 w-full select-none"
      onClick={(e) => {
        // click on empty track -> seek playhead
        const t = pxToTime(e.clientX)
        onSelect?.(-1) // deselect
        // bubble up via custom event so page can seek
        window.dispatchEvent(
          new CustomEvent('clipforge:seek', { detail: Math.round(t) }),
        )
      }}
      style={{ width: `${zoom * 100}%`, minWidth: '100%' }}
    >
      {/* track background */}
      <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-full bg-muted/60 ring-1 ring-inset ring-border/40" />

      {/* speech density strip (real word timestamps → where speech actually is) */}
      {hasSpeech && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex h-3 -translate-y-1/2 items-center gap-px overflow-hidden rounded-full px-px" aria-hidden>
          {speechStrip.map((v, i) => (
            <span
              key={i}
              className="h-full flex-1 rounded-[1px] bg-emerald-500/45"
              style={{ opacity: v > 0 ? 0.25 + v * 0.75 : 0.06, transform: v > 0 ? 'scaleY(1)' : 'scaleY(0.35)' }}
            />
          ))}
        </div>
      )}

      {/* ticks */}
      {ticks.map((t, i) => (
        <div
          key={i}
          className="absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-border/60"
          style={{ left: `${(t / total) * 100}%` }}
        />
      ))}

      {/* playhead */}
      {playStart != null && (
        <div
          className="pointer-events-none absolute top-0 z-30 h-full"
          style={{ left: `${(playStart / total) * 100}%` }}
        >
          <div className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 rounded-sm bg-primary" />
          <div className="h-full w-px -translate-x-1/2 bg-primary/80" />
        </div>
      )}

      {/* clip segments */}
      {clips.map((clip, idx) => {
        const left = (clip.startTime / total) * 100
        const width = ((clip.endTime - clip.startTime) / total) * 100
        const selected = selectedId === clip.id || selectedId === `local-${idx}`
        const isRejected = clip.status === 'rejected'
        return (
          <motion.div
            key={clip.id ?? `local-${idx}`}
            initial={{ opacity: 0, scaleX: 0.8 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ duration: 0.3, delay: idx * 0.04 }}
            onClick={(e) => {
              e.stopPropagation()
              onSelect?.(idx)
            }}
            className="group absolute top-1/2 flex h-8 -translate-y-1/2 cursor-pointer items-center overflow-hidden rounded-md ring-1 transition-all hover:z-10 hover:h-10"
            style={{
              left: `${left}%`,
              width: `${Math.max(width, 1)}%`,
              background: isRejected
                ? `repeating-linear-gradient(45deg, color-mix(in oklch, ${getScoreHex(clip.score)} 30%, transparent), color-mix(in oklch, ${getScoreHex(clip.score)} 30%, transparent) 4px, transparent 4px, transparent 8px)`
                : `linear-gradient(180deg, color-mix(in oklch, ${getScoreHex(clip.score)} 90%, transparent), color-mix(in oklch, ${getScoreHex(clip.score)} 55%, transparent))`,
              boxShadow: selected
                ? `0 0 0 2px var(--background), 0 0 0 4px ${getScoreHex(clip.score)}`
                : 'none',
              zIndex: selected ? 20 : 1,
              opacity: isRejected ? 0.6 : 1,
            }}
            title={`${clip.title} · ${fmtTime(clip.startTime)}–${fmtTime(clip.endTime)}`}
          >
            <span className="pointer-events-none flex h-full flex-1 items-center justify-center px-1.5 text-[9px] font-bold text-white drop-shadow-sm tabular-nums">
              {clip.score}
            </span>
            {/* tooltip on hover */}
            <span className="pointer-events-none absolute -top-9 left-1/2 z-30 hidden -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[10px] text-popover-foreground shadow-md group-hover:block">
              {fmtTime(clip.startTime)} → {fmtTime(clip.endTime)}
            </span>

            {/* trim handles - only on selected */}
            {selected && onTrimStart && (
              <TrimHandle
                side="left"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setDrag({ type: 'start', idx, startMouseX: e.clientX, orig: clip.startTime })
                }}
              />
            )}
            {selected && onTrimEnd && (
              <TrimHandle
                side="right"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setDrag({ type: 'end', idx, startMouseX: e.clientX, orig: clip.endTime })
                }}
              />
            )}
          </motion.div>
        )
      })}
    </div>
  )

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Timeline
          {hasSpeech && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-600 dark:text-emerald-400">
              <Scan className="h-2.5 w-2.5" />
              speech map · trim snaps to words
            </span>
          )}
          {snapHint && (
            <motion.span
              initial={{ opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              className="inline-flex max-w-[220px] truncate items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-600 dark:text-amber-400"
            >
              {snapHint}
            </motion.span>
          )}
        </span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {clips.length} clips · {fmtTime(total)} total
          </span>
          {playStart != null && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary tabular-nums">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              {fmtTime(playStart)}
            </span>
          )}
          {/* zoom controls */}
          <div className="flex items-center overflow-hidden rounded-md border border-border/50">
            <button
              type="button"
              aria-label="Zoom out"
              disabled={zoom <= 1}
              onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
              className="px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-30"
            >
              <Minimize2 className="h-3 w-3" />
            </button>
            <span className="px-1 text-[9px] tabular-nums text-muted-foreground">{zoom}×</span>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= 4}
              onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.5) * 2) / 2))}
              className="px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-30"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {/* scrollable surface when zoomed */}
      <div
        ref={scrollRef}
        className="relative w-full overflow-x-auto overflow-y-hidden pb-1"
        style={{ scrollbarWidth: 'thin' }}
      >
        {trackInner}
      </div>

      {/* time scale */}
      <div className="relative mt-1 h-4 overflow-hidden">
        <div style={{ width: `${zoom * 100}%`, minWidth: '100%' }} className="relative h-full">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ left: `${(t / total) * 100}%` }}
            >
              {fmtTime(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function TrimHandle({
  side,
  onPointerDown,
}: {
  side: 'left' | 'right'
  onPointerDown: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onMouseDown={onPointerDown}
      className={`absolute top-1/2 z-40 h-6 w-2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-sm bg-foreground/90 shadow-md ring-1 ring-background transition-transform hover:scale-x-125 ${
        side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
      }`}
      title={`Drag to trim ${side === 'left' ? 'start' : 'end'} — snaps to speech when word data exists`}
    >
      <div className="flex flex-col gap-0.5">
        <div className="h-2 w-px bg-background/80" />
        <div className="h-2 w-px bg-background/80" />
      </div>
    </div>
  )
}

function getScoreHex(score: number): string {
  if (score >= 85) return '#10b981' // emerald
  if (score >= 70) return '#84cc16' // lime
  if (score >= 50) return '#f59e0b' // amber
  return '#f43f5e' // rose
}

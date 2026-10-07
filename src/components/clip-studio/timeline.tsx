'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { fmtTime, type SuggestedClip } from '@/lib/youtube'

interface Props {
  clips: SuggestedClip[]
  duration: number
  selectedId?: string | null
  onSelect?: (idx: number) => void
  onTrimStart?: (idx: number, newStart: number) => void
  onTrimEnd?: (idx: number, newEnd: number) => void
  playStart?: number | null
}

export function Timeline({
  clips,
  duration,
  selectedId,
  onSelect,
  onTrimStart,
  onTrimEnd,
  playStart,
}: Props) {
  const ref = React.useRef<HTMLDivElement>(null)
  const total = Math.max(duration, 1)
  const [zoom, setZoom] = React.useState(1)
  const [drag, setDrag] = React.useState<
    | { type: 'start' | 'end'; idx: number; startMouseX: number; orig: number }
    | null
  >(null)

  // Build tick marks
  const tickCount = 6
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (i / tickCount) * total)

  const pxToTime = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    return (x / rect.width) * total
  }

  React.useEffect(() => {
    if (!drag) return
    const handleMove = (e: MouseEvent) => {
      const dt = pxToTime(e.clientX)
      const clip = clips[drag.idx]
      if (!clip) return
      if (drag.type === 'start') {
        const ns = Math.max(0, Math.min(clip.endTime - 1, dt))
        onTrimStart?.(drag.idx, Math.round(ns * 10) / 10)
      } else {
        const ne = Math.max(clip.startTime + 1, Math.min(total, dt))
        onTrimEnd?.(drag.idx, Math.round(ne * 10) / 10)
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
  }, [drag, clips, total, onTrimStart, onTrimEnd])

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Timeline
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
        </div>
      </div>

      {/* Track */}
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
      >
        {/* track background */}
        <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-full bg-muted/60 ring-1 ring-inset ring-border/40" />

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

      {/* time scale */}
      <div className="relative mt-1 h-4 w-full">
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
      className={`absolute top-1/2 z-40 h-6 w-2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-sm bg-foreground/90 shadow-md ring-1 ring-background ${
        side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
      }`}
      title={`Drag to trim ${side === 'left' ? 'start' : 'end'}`}
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

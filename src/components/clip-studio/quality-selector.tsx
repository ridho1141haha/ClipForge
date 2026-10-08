'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Zap, SlidersHorizontal, Gem, HelpCircle } from 'lucide-react'
import { RENDER_QUALITIES, type RenderQuality } from '@/lib/render-recipe'

// ---------------------------------------------------------------------------
// QualitySelector — 3-option render-quality control (draft / standard / high).
// Visual language matches the app's source-selector cards: selected option
// gets the primary ring + tinted icon tile; a compact hint explains the
// tradeoff under each label. Consumes useRenderQuality so the single-render
// and batch-render selectors stay in sync (localStorage + CustomEvent).
// ---------------------------------------------------------------------------

const ICONS: Record<RenderQuality, React.ReactNode> = {
  draft: <Zap className="h-3.5 w-3.5" />,
  standard: <SlidersHorizontal className="h-3.5 w-3.5" />,
  high: <Gem className="h-3.5 w-3.5" />,
}

interface Props {
  quality: RenderQuality
  onSelect: (q: RenderQuality) => void
  /** lock the control while a render/batch is in flight */
  disabled?: boolean
  /** compact variant for inline placement (batch header row) */
  compact?: boolean
}

export function QualitySelector({ quality, onSelect, disabled = false, compact = false }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Render quality"
      className={`grid grid-cols-3 gap-1.5 ${disabled ? 'pointer-events-none opacity-60' : ''}`}
    >
      {RENDER_QUALITIES.map((opt) => {
        const selected = quality === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(opt.id)}
            title={`${opt.label} — ${opt.dims} · ${opt.hint}`}
            className={`relative rounded-lg border p-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              selected
                ? 'border-primary/60 bg-primary/10 shadow-sm ring-1 ring-primary/25'
                : 'border-border/60 bg-card/40 hover:border-primary/30 hover:bg-card/70'
            } ${compact ? 'min-w-0' : ''}`}
          >
            <span className="flex items-center gap-1.5">
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-md transition-colors ${
                  selected ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                }`}
              >
                {ICONS[opt.id]}
              </span>
              <span className="truncate text-[11px] font-semibold leading-none">{opt.label}</span>
              {selected && !compact ? (
                <motion.span
                  layoutId="quality-check"
                  className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="mt-1 flex items-center gap-1 text-[9px] leading-tight text-muted-foreground">
              <span className="font-mono tabular-nums">{opt.dims}</span>
              {!compact && <span className="text-muted-foreground/50">·</span>}
              {!compact && <span className="truncate">{opt.hint}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Small labeled wrapper for the selector (single-render card layout). */
export function QualityField(props: Omit<Props, 'compact'>) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <SlidersHorizontal className="h-3 w-3 text-primary" />
          Render quality
        </div>
        <span
          className="hidden items-center gap-1 text-[10px] text-muted-foreground/70 sm:inline-flex"
          title="Draft renders ~2-3x faster at 720p; High maximizes fidelity at 1080p"
        >
          <HelpCircle className="h-3 w-3" />
          speed vs fidelity
        </span>
      </div>
      <QualitySelector {...props} />
    </div>
  )
}

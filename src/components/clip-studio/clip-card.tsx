'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Check,
  X,
  Pencil,
  Play,
  Clock,
  Quote,
  TrendingUp,
  Copy,
  Scissors,
  RotateCcw,
  AlertTriangle,
  Sparkles,
  FileText,
  ShieldCheck,
  MoveHorizontal,
  BadgeCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  fmtTime,
  fmtDuration,
  scoreColor,
  statusColor,
  type SuggestedClip,
} from '@/lib/youtube'
import {
  SCORE_DIMENSIONS,
  scoreColor10,
  type ClipScores,
} from '@/lib/editplan'

interface Props {
  clip: SuggestedClip
  index: number
  selected: boolean
  multiSelected: boolean
  hasPlan: boolean
  onToggleSelect: (e: React.MouseEvent) => void
  onApprove: () => void
  onReject: () => void
  onReset: () => void
  onEdit: () => void
  onPlay: () => void
  onDuplicate: () => void
  onSplit: () => void
  onInlineEditTitle: (v: string) => void
  onInlineEditHook: (v: string) => void
  onGeneratePlan: () => void
  onAutoEdit: () => void
}

export function ClipCard({
  clip,
  index,
  selected,
  multiSelected,
  hasPlan,
  onToggleSelect,
  onApprove,
  onReject,
  onReset,
  onEdit,
  onPlay,
  onDuplicate,
  onSplit,
  onInlineEditTitle,
  onInlineEditHook,
  onGeneratePlan,
  onAutoEdit,
}: Props) {
  const sc = scoreColor(clip.score)
  const status = clip.status ?? 'suggested'
  const duration = clip.endTime - clip.startTime
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [editingHook, setEditingHook] = React.useState(false)
  const [draftTitle, setDraftTitle] = React.useState(clip.title)
  const [draftHook, setDraftHook] = React.useState(clip.hookText)
  const [showScores, setShowScores] = React.useState(false)
  const titleRef = React.useRef<HTMLTextAreaElement>(null)
  const hookRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    if (editingTitle && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
    }
  }, [editingTitle])
  React.useEffect(() => {
    if (editingHook && hookRef.current) {
      hookRef.current.focus()
      hookRef.current.select()
    }
  }, [editingHook])

  const commitTitle = () => {
    const v = draftTitle.trim() || clip.title
    onInlineEditTitle(v)
    setDraftTitle(v)
    setEditingTitle(false)
  }
  const commitHook = () => {
    onInlineEditHook(draftHook)
    setEditingHook(false)
  }

  const scores = clip.scores
  const rec = clip.recommendation

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      onClick={onToggleSelect}
      className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-card/60 p-4 transition-all ${
        selected
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border/70 hover:border-primary/40 hover:shadow-md'
      } ${multiSelected && !selected ? 'border-primary/40 bg-primary/5' : ''} ${
        status === 'rejected' ? 'opacity-55' : ''
      }`}
    >
      {/* score bar on left */}
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: getScoreHex(clip.score) }}
      />
      {/* recommendation ribbon */}
      {rec === 'SKIP' && (
        <div className="absolute right-0 top-0 z-10 rounded-bl-lg bg-rose-500/90 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
          Skip
        </div>
      )}
      {/* multi-select checkbox */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleSelect(e)
        }}
        className={`absolute right-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-md border transition-all ${
          rec === 'SKIP' ? 'top-7' : ''
        } ${
          multiSelected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-background/80 opacity-0 group-hover:opacity-100'
        }`}
        aria-label="Toggle multi-select"
      >
        {multiSelected && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>

      <div className="flex items-start gap-3 pl-2">
        {/* index circle */}
        <div
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold ${sc.bg} ${sc.text}`}
        >
          {index + 1}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2 pr-6">
            {editingTitle ? (
              <textarea
                ref={titleRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    commitTitle()
                  }
                  if (e.key === 'Escape') {
                    setDraftTitle(clip.title)
                    setEditingTitle(false)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                rows={1}
                className="flex-1 resize-none rounded-md border border-primary/40 bg-background px-2 py-1 text-sm font-semibold leading-snug focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            ) : (
              <h4
                onClick={(e) => {
                  e.stopPropagation()
                  setDraftTitle(clip.title)
                  setEditingTitle(true)
                }}
                className="line-clamp-2 flex-1 cursor-text text-sm font-semibold leading-snug text-foreground hover:underline decoration-primary/40 decoration-dotted underline-offset-2"
                title="Click to edit title"
              >
                {clip.title}
              </h4>
            )}
            <div
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${sc.bg} ${sc.text} ring-1 ${sc.ring}`}
              title={`Clip score: ${clip.score}/100`}
            >
              <TrendingUp className="h-3 w-3" />
              {clip.score}
            </div>
          </div>

          {/* time range + badges */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              <Clock className="h-3 w-3" />
              {fmtTime(clip.startTime)} → {fmtTime(clip.endTime)}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <span className="tabular-nums">{fmtDuration(duration)}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusColor(status)}`}>
              {status}
            </span>
            {clip.contextRisk && (
              <span
                className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                title="Context risk: this clip may mislead the speaker without more context"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                ctx risk
              </span>
            )}
            {!clip.contextRisk && clip.contextStatus === 'PASS' && (
              <span
                className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                title="Context validated against transcript: clip stands alone"
              >
                <ShieldCheck className="h-2.5 w-2.5" />
                ctx pass
              </span>
            )}
            {clip.contextStatus === 'EXTEND' && (
              <span
                className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                title="Clip boundaries were extended using transcript context to remain standalone"
              >
                <MoveHorizontal className="h-2.5 w-2.5" />
                extended
              </span>
            )}
            {rec === 'POST' && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                <Sparkles className="h-2.5 w-2.5" />
                POST
              </span>
            )}
            {hasPlan && (
              <span className="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                <FileText className="h-2.5 w-2.5" />
                plan
              </span>
            )}
          </div>

          {/* multi-dimensional score breakdown (expandable) */}
          {scores && (
            <div className="mt-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowScores((v) => !v)
                }}
                className="flex w-full items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/50"
              >
                <TrendingUp className="h-3 w-3" />
                Score breakdown
                <span className="ml-auto flex items-center gap-1">
                  {SCORE_DIMENSIONS.slice(0, 4).map((d) => {
                    const v = (scores as ClipScores)[d.key]
                    const c = scoreColor10(v)
                    return (
                      <span
                        key={d.key}
                        className={`h-1.5 w-6 rounded-full ${c.bg}`}
                        title={`${d.label}: ${v}/10`}
                      />
                    )
                  })}
                  <span className="text-muted-foreground/70">{showScores ? '▾' : '▸'}</span>
                </span>
              </button>
              {showScores && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="mt-1.5 grid grid-cols-2 gap-1.5"
                >
                  {SCORE_DIMENSIONS.map((d) => {
                    const v = (scores as ClipScores)[d.key]
                    const c = scoreColor10(v)
                    return (
                      <div
                        key={d.key}
                        className="flex items-center justify-between gap-1.5 rounded bg-muted/20 px-1.5 py-1"
                      >
                        <span className="text-[10px] text-muted-foreground">{d.label}</span>
                        <span className="flex items-center gap-1.5">
                          <span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
                            <span
                              className={`block h-full rounded-full ${c.bg}`}
                              style={{ width: `${(v / 10) * 100}%` }}
                            />
                          </span>
                          <span className={`w-6 text-right text-[10px] font-bold tabular-nums ${c.text}`}>
                            {v}
                          </span>
                        </span>
                      </div>
                    )
                  })}
                </motion.div>
              )}
            </div>
          )}

          {/* hook text - inline editable */}
          {editingHook ? (
            <textarea
              ref={hookRef}
              value={draftHook}
              onChange={(e) => setDraftHook(e.target.value)}
              onBlur={commitHook}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitHook()
                }
                if (e.key === 'Escape') {
                  setDraftHook(clip.hookText)
                  setEditingHook(false)
                }
              }}
              onClick={(e) => e.stopPropagation()}
              rows={2}
              className="mt-2 w-full resize-none rounded-md border border-primary/40 bg-background px-2 py-1.5 text-xs italic focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          ) : (
            clip.hookText && (
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  setDraftHook(clip.hookText)
                  setEditingHook(true)
                }}
                className="mt-2 flex cursor-text items-start gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-xs italic text-foreground/80 hover:bg-primary/10"
                title="Click to edit hook"
              >
                <Quote className="h-3 w-3 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="line-clamp-2">{clip.hookText}</span>
                  {clip.hookVerified ? (
                    <span className="mt-0.5 inline-flex items-center gap-0.5 text-[9px] font-semibold not-italic text-emerald-600 dark:text-emerald-400">
                      <BadgeCheck className="h-2.5 w-2.5" /> verified in transcript
                    </span>
                  ) : (
                    <span className="mt-0.5 inline-flex items-center gap-0.5 text-[9px] font-semibold not-italic text-muted-foreground/70">
                      <AlertTriangle className="h-2.5 w-2.5" /> unverified (no transcript evidence)
                    </span>
                  )}
                </span>
              </div>
            )
          )}

          {/* tags */}
          {clip.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {clip.tags.slice(0, 5).map((t, i) => (
                <span
                  key={i}
                  className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}

          {/* summary */}
          {clip.summary && (
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {clip.summary}
            </p>
          )}

          {/* actions */}
          <div className="mt-3 flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                onPlay()
              }}
              className="h-7 gap-1 px-2 text-xs"
            >
              <Play className="h-3 w-3" />
              Preview
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
              className="h-7 gap-1 px-2 text-xs"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
            <Button
              size="sm"
              variant={hasPlan ? 'secondary' : 'default'}
              onClick={(e) => {
                e.stopPropagation()
                onGeneratePlan()
              }}
              className="h-7 gap-1 px-2 text-xs"
              title="Generate full AI edit plan"
            >
              <Sparkles className="h-3 w-3" />
              {hasPlan ? 'View plan' : 'AI plan'}
            </Button>
            {hasPlan && (
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation()
                  onAutoEdit()
                }}
                className="h-7 gap-1 px-2 text-xs"
                title="Auto-edit preview — applies plan to video live"
              >
                <Play className="h-3 w-3" />
                Auto-Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                onSplit()
              }}
              className="h-7 gap-1 px-2 text-xs"
              title="Split clip in half"
            >
              <Scissors className="h-3 w-3" />
              Split
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                onDuplicate()
              }}
              className="h-7 gap-1 px-2 text-xs"
              title="Duplicate clip"
            >
              <Copy className="h-3 w-3" />
              Copy
            </Button>
            <div className="ml-auto flex items-center gap-0.5">
              {status !== 'suggested' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    onReset()
                  }}
                  className="h-7 px-1.5 text-xs text-muted-foreground"
                  title="Reset to suggested"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  onApprove()
                }}
                className={`h-7 px-2 text-xs ${
                  status === 'approved'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : ''
                }`}
                title="Approve clip (A)"
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  onReject()
                }}
                className={`h-7 px-2 text-xs ${
                  status === 'rejected'
                    ? 'text-rose-600 dark:text-rose-400'
                    : ''
                }`}
                title="Reject clip (R)"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function getScoreHex(score: number): string {
  if (score >= 85) return '#10b981'
  if (score >= 70) return '#84cc16'
  if (score >= 50) return '#f59e0b'
  return '#f43f5e'
}

export { getScoreHex }

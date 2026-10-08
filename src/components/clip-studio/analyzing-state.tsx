'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Scissors,
  Sparkles,
  Brain,
  Wand2,
  TrendingUp,
  Check,
  Film,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const STEPS = [
  { icon: Film, label: 'Fetching video metadata', delay: 0, duration: 0.6 },
  { icon: Brain, label: 'AI analyzing content structure', delay: 0.5, duration: 1.0 },
  { icon: TrendingUp, label: 'Detecting viral highlight moments', delay: 1.2, duration: 1.2 },
  { icon: Wand2, label: 'Writing hooks & scoring clips', delay: 2.0, duration: 1.0 },
]

const SCORE_DIMS = ['Hook', 'Curiosity', 'Payoff', 'Standalone', 'Share', 'Emotion', 'Safe']

interface Props {
  /** REAL stage text from the async prepare job (when the job pipeline is in use) */
  stageText?: string | null
  /** REAL job progress 0-100 (when available) */
  progress?: number | null
  /** prepare job failed → show retry + fallback actions */
  prepareError?: string | null
  onRetryPrepare?: () => void
  onSkipPrepare?: () => void
}

export function AnalyzingState({ stageText, progress, prepareError, onRetryPrepare, onSkipPrepare }: Props) {
  const [activeStep, setActiveStep] = React.useState(0)

  React.useEffect(() => {
    if (prepareError) return
    const timers = STEPS.map((s, i) => setTimeout(() => setActiveStep(i + 1), (s.delay + s.duration) * 1000))
    return () => timers.forEach(clearTimeout)
  }, [prepareError])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="mx-auto max-w-md rounded-2xl border border-border/60 bg-card/60 p-6 shadow-xl"
    >
      {/* header with orbiting animation */}
      <div className="relative mb-6 grid place-items-center">
        <div className="relative grid h-16 w-16 place-items-center rounded-2xl bg-primary text-primary-foreground pulse-ring">
          <Sparkles className="h-7 w-7 animate-pulse" />
        </div>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute h-2 w-2 rounded-full bg-primary/70"
            animate={{ rotate: 360, scale: [1, 1.3, 1] }}
            transition={{
              rotate: { duration: 2, repeat: Infinity, ease: 'linear', delay: i * 0.2 },
              scale: { duration: 1, repeat: Infinity, delay: i * 0.3 },
            }}
            style={{
              transformOrigin: 'center',
              left: '50%',
              top: '50%',
              marginLeft: 28 * Math.cos((i * 2 * Math.PI) / 3),
              marginTop: 28 * Math.sin((i * 2 * Math.PI) / 3),
            }}
          />
        ))}
      </div>

      {/* REAL prepare-job stage (progress + live text) when provided */}
      {stageText && !prepareError && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
              <Scissors className="h-3 w-3 animate-pulse" />
              Preparing source
            </p>
            {typeof progress === 'number' && (
              <span className="text-[10px] font-semibold text-sky-600 dark:text-sky-400 tabular-nums">{progress}%</span>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-500"
              animate={{ width: `${Math.max(4, progress ?? 8)}%` }}
              transition={{ ease: 'easeOut', duration: 0.5 }}
            />
          </div>
          <p className="mt-1.5 truncate text-[11px] text-muted-foreground" title={stageText}>
            {stageText}
          </p>
        </motion.div>
      )}

      {/* prepare failed → honest error + retry */}
      {prepareError && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>Source preparation failed.</strong> {prepareError}
              <br />
              YouTube may be blocking this server temporarily — retry usually works.
            </span>
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {onRetryPrepare && (
              <Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={onRetryPrepare}>
                <RotateCcw className="h-3 w-3" />
                Retry prepare
              </Button>
            )}
            {onSkipPrepare && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={onSkipPrepare}>
                Analyze without transcript
              </Button>
            )}
          </div>
        </motion.div>
      )}

      {/* steps with checkmarks */}
      <div className="space-y-2.5">
        {STEPS.map((s, i) => {
          const Icon = s.icon
          const done = activeStep > i
          const active = activeStep === i
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: s.delay, duration: 0.4 }}
              className="flex items-center gap-3"
            >
              <div
                className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors ${
                  done
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                ) : (
                  <Icon className={`h-3.5 w-3.5 ${active ? 'animate-pulse' : ''}`} />
                )}
                {active && (
                  <motion.span
                    className="absolute -inset-0.5 rounded-md border-2 border-primary"
                    animate={{ opacity: [0.5, 0, 0.5] }}
                    transition={{ duration: 1, repeat: Infinity }}
                  />
                )}
              </div>
              <div className="flex-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    initial={{ width: '0%' }}
                    animate={{ width: done ? '100%' : active ? '60%' : '0%' }}
                    transition={{ duration: done ? 0.3 : 1, ease: 'easeInOut' }}
                    className={`h-full rounded-full ${done ? 'bg-emerald-500' : 'bg-primary'}`}
                  />
                </div>
              </div>
              <span className={`w-44 text-xs ${done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                {s.label}
              </span>
            </motion.div>
          )
        })}
      </div>

      {/* score dimensions preview */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: activeStep >= 2 ? 1 : 0 }}
        transition={{ duration: 0.5 }}
        className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-3"
      >
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          <TrendingUp className="h-3 w-3" />
          Scoring across 7 dimensions
        </p>
        <div className="grid grid-cols-7 gap-1">
          {SCORE_DIMS.map((dim, i) => (
            <motion.div
              key={dim}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2 + i * 0.1, duration: 0.3 }}
              className="text-center"
            >
              <div className="mx-auto mb-0.5 h-8 w-full overflow-hidden rounded bg-muted/40">
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${30 + Math.random() * 60}%` }}
                  transition={{ delay: 2.2 + i * 0.1, duration: 0.5 }}
                  className="mt-auto bg-gradient-to-t from-primary/60 to-primary"
                  style={{ marginTop: 'auto' }}
                />
              </div>
              <span className="text-[8px] text-muted-foreground">{dim}</span>
            </motion.div>
          ))}
        </div>
      </motion.div>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        ClipForge AI is reading the video&apos;s context and projecting the most
        shareable moments…
      </p>
    </motion.div>
  )
}

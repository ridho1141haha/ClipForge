'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play,
  Sparkles,
  Scissors,
  TrendingUp,
  Check,
} from 'lucide-react'

// Mini animated mockup showing the ClipForge flow
// Cycles: input link → analyze → clip candidates appear → one gets a plan

const MOCK_CLIPS = [
  { score: 92, label: 'Hook', color: 'bg-emerald-500', title: 'The opening hook' },
  { score: 84, label: 'Story', color: 'bg-lime-500', title: 'Key story moment' },
  { score: 78, label: 'Insight', color: 'bg-amber-500', title: 'Surprising insight' },
]

export function LivePreviewCard() {
  const [phase, setPhase] = React.useState<'input' | 'analyzing' | 'clips' | 'plan'>('input')

  React.useEffect(() => {
    const seq: Array<[number, typeof phase]> = [
      [0, 'input'],
      [2000, 'analyzing'],
      [3500, 'clips'],
      [6000, 'plan'],
      [9000, 'input'],
    ]
    let idx = 0
    const tick = () => {
      if (idx >= seq.length) {
        idx = 0
      }
      const [, p] = seq[idx]
      setPhase(p)
      idx++
    }
    tick()
    const interval = setInterval(tick, 3000)
    return () => clearInterval(interval)
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, rotateX: 8 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ duration: 0.6, delay: 0.3 }}
      className="relative mx-auto mt-10 max-w-md"
    >
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-2xl shadow-primary/10 backdrop-blur-xl">
        {/* window chrome */}
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/30 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ml-2 text-[10px] font-medium text-muted-foreground">clipforge.studio</span>
          <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <Sparkles className="h-2.5 w-2.5 text-primary" />
            live demo
          </div>
        </div>

        {/* body */}
        <div className="relative h-56 p-3">
          <AnimatePresence mode="wait">
            {phase === 'input' && (
              <motion.div
                key="input"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex h-full flex-col justify-center"
              >
                <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded bg-primary/10 grid place-items-center">
                      <Play className="h-3 w-3 text-primary" />
                    </div>
                    <div className="flex-1 h-2.5 rounded-full bg-muted" />
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">Paste a YouTube link…</p>
                </div>
                <div className="mt-2 flex gap-1.5">
                  {['⚡ Shorts', '🎙️ Podcast', '💼 Business'].map((t, i) => (
                    <span key={i} className="rounded-full bg-muted/60 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              </motion.div>
            )}

            {phase === 'analyzing' && (
              <motion.div
                key="analyzing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex h-full flex-col items-center justify-center gap-3"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  className="grid h-10 w-10 place-items-center rounded-full border-2 border-primary/30 border-t-primary"
                />
                <p className="text-xs font-medium text-primary">AI analyzing content…</p>
                <div className="w-3/4 space-y-1.5">
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      initial={{ width: '0%' }}
                      animate={{ width: '100%' }}
                      transition={{ duration: 0.8, delay: i * 0.2, repeat: Infinity, repeatType: 'reverse' }}
                      className="h-1 rounded-full bg-primary/40"
                    />
                  ))}
                </div>
              </motion.div>
            )}

            {phase === 'clips' && (
              <motion.div
                key="clips"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-1.5"
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-500">
                  3 clips found
                </p>
                {MOCK_CLIPS.map((c, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.15 }}
                    className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 p-1.5"
                  >
                    <div className={`grid h-6 w-6 shrink-0 place-items-center rounded ${c.color} text-[10px] font-bold text-white`}>
                      {c.score}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10px] font-semibold">{c.title}</p>
                      <p className="text-[9px] text-muted-foreground">{c.label}</p>
                    </div>
                    <TrendingUp className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                ))}
              </motion.div>
            )}

            {phase === 'plan' && (
              <motion.div
                key="plan"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-1.5"
              >
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-violet-500">
                  <Sparkles className="h-2.5 w-2.5" />
                  Edit Plan Generated
                </p>
                {/* mini segment timeline */}
                <div className="flex h-3 overflow-hidden rounded">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '25%' }}
                    className="bg-rose-500"
                  />
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '35%' }}
                    transition={{ delay: 0.1 }}
                    className="bg-sky-500"
                  />
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '40%' }}
                    transition={{ delay: 0.2 }}
                    className="bg-emerald-500"
                  />
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { icon: <Scissors className="h-2.5 w-2.5" />, label: 'Segments', count: 4 },
                    { icon: <TrendingUp className="h-2.5 w-2.5" />, label: 'Cuts', count: 2 },
                    { icon: <Check className="h-2.5 w-2.5" />, label: 'Subtitles', count: 7 },
                  ].map((s, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.3 + i * 0.08 }}
                      className="rounded border border-border/40 bg-background/40 p-1.5 text-center"
                    >
                      <div className="mx-auto mb-0.5 text-violet-500">{s.icon}</div>
                      <p className="text-[14px] font-bold leading-none">{s.count}</p>
                      <p className="text-[8px] text-muted-foreground">{s.label}</p>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* floating accent */}
      <motion.div
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -right-3 top-12 hidden rounded-lg border border-primary/30 bg-card px-2.5 py-1.5 shadow-lg sm:block"
      >
        <p className="text-[9px] font-bold uppercase tracking-wide text-primary">POST</p>
      </motion.div>
    </motion.div>
  )
}

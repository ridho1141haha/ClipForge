'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, Scissors, Sparkles, Clock, Zap } from 'lucide-react'
import { useCountUp, useInView } from '@/hooks/use-count-up'

interface Stat {
  icon: React.ReactNode
  value: number
  suffix?: string
  label: string
  color: string
}

export function HeroStats() {
  const { ref, inView } = useInView<HTMLDivElement>()
  const stats: Stat[] = [
    { icon: <Zap className="h-4 w-4" />, value: 7, suffix: 's', label: 'Avg analyze time', color: 'text-amber-500' },
    { icon: <Scissors className="h-4 w-4" />, value: 8, label: 'Style presets', color: 'text-violet-500' },
    { icon: <TrendingUp className="h-4 w-4" />, value: 7, label: 'Score dimensions', color: 'text-emerald-500' },
    { icon: <Sparkles className="h-4 w-4" />, value: 4, label: 'Export formats', color: 'text-sky-500' },
  ]
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4"
    >
      {stats.map((s, i) => (
        <StatCard key={i} stat={s} inView={inView} delay={i * 0.08} />
      ))}
    </motion.div>
  )
}

function StatCard({ stat, inView, delay }: { stat: Stat; inView: boolean; delay: number }) {
  const value = useCountUp(stat.value, 1200, inView)
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={inView ? { opacity: 1, scale: 1 } : {}}
      transition={{ delay, duration: 0.4 }}
      className="group relative overflow-hidden rounded-xl border border-border/60 bg-card/40 p-3.5 backdrop-blur-sm transition-all hover:border-primary/40 hover:shadow-lg"
    >
      <div className="absolute -right-3 -top-3 h-12 w-12 rounded-full bg-primary/5 transition-transform group-hover:scale-150" />
      <div className="relative">
        <div className={`mb-1.5 ${stat.color}`}>{stat.icon}</div>
        <div className="flex items-baseline gap-0.5">
          <span className="text-2xl font-bold tabular-nums text-foreground">{value}</span>
          {stat.suffix && <span className="text-sm font-semibold text-muted-foreground">{stat.suffix}</span>}
        </div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{stat.label}</p>
      </div>
    </motion.div>
  )
}

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Brain,
  Scissors,
  TrendingUp,
  Sparkles,
  Camera,
  Type,
  Volume2,
  Film,
  Zap,
  Download,
  Keyboard,
  Palette,
  Eye,
} from 'lucide-react'

const FEATURES = [
  {
    icon: Brain,
    title: '7-Dimension Scoring',
    desc: 'Hook · Curiosity · Payoff · Standalone · Shareability · Emotion · Context Safety — each 0–10, weighted to a 100-point total.',
    color: 'text-violet-500',
    bg: 'bg-violet-500/10',
  },
  {
    icon: Scissors,
    title: '8 Editing Styles',
    desc: 'Podcast · Business · Educational · Storytelling · Gaming · Funny · Motivational · News — each drives different AI behavior.',
    color: 'text-sky-500',
    bg: 'bg-sky-500/10',
  },
  {
    icon: TrendingUp,
    title: 'POST / SKIP Recommendations',
    desc: 'AI flags clips worth posting (≥60 score + high context safety) and flags risky ones before you waste time on them.',
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
  },
  {
    icon: Eye,
    title: 'Auto-Edit Live Preview',
    desc: 'Watch the edit plan apply to the YouTube video in real-time: cut-skipping, punch-in zoom, animated subtitles, sound cues.',
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
  },
  {
    icon: Camera,
    title: 'Camera Punch-In Plans',
    desc: 'Auto-generated zoompan movements (1.0–1.18×) keyed to emphasis moments, with reasons for every move.',
    color: 'text-rose-500',
    bg: 'bg-rose-500/10',
  },
  {
    icon: Type,
    title: 'Emphasized Subtitles',
    desc: 'Mobile-optimized subtitle blocks (1–2 lines, 3–7 words) with bold/uppercase/color/pop emphasis on key words.',
    color: 'text-cyan-500',
    bg: 'bg-cyan-500/10',
  },
  {
    icon: Volume2,
    title: 'Sound Design',
    desc: 'SFX recommendations (whoosh · impact · pop · bass_hit · record_scratch · crowd) with intensity + music ducking plans.',
    color: 'text-orange-500',
    bg: 'bg-orange-500/10',
  },
  {
    icon: Film,
    title: 'B-roll & Visual Prompts',
    desc: 'AI generates 9:16 image-gen prompts for each visual insertion — paste them into any AI image tool for instant B-roll.',
    color: 'text-fuchsia-500',
    bg: 'bg-fuchsia-500/10',
  },
  {
    icon: Download,
    title: '4 Export Formats',
    desc: 'JSON (full data) · CSV (spreadsheet) · SRT (subtitles) · EDL (edit decision list) — plus downloadable ffmpeg render script.',
    color: 'text-lime-500',
    bg: 'bg-lime-500/10',
  },
  {
    icon: Palette,
    title: 'Inline & Bulk Editing',
    desc: 'Click to edit titles & hooks inline, multi-select for bulk approve/reject/duplicate/split, sort & filter by score/status.',
    color: 'text-indigo-500',
    bg: 'bg-indigo-500/10',
  },
  {
    icon: Keyboard,
    title: 'Keyboard Shortcuts',
    desc: 'J/K navigate · A approve · R reject · P AI plan · Space preview · D duplicate · S split — pro editor speed.',
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
  },
  {
    icon: Zap,
    title: 'No Setup, No API Key',
    desc: 'Uses YouTube oEmbed (no key) + built-in LLM. Paste a link and go — results in under 15 seconds.',
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
  },
]

export function FeaturesGrid() {
  return (
    <section id="features" className="scroll-mt-20">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-8 text-center">
          <span className="mb-2 inline-block rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Capabilities
          </span>
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Everything a short-form editor needs
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-muted-foreground">
            From multi-dimensional clip scoring to a full structured edit plan with
            subtitles, camera moves, visuals, and sound — all AI-generated, all editable.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => {
            const Icon = f.icon
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.35, delay: (i % 3) * 0.08 }}
                className="group relative overflow-hidden rounded-xl border border-border/60 bg-card/40 p-4 transition-all hover:border-primary/40 hover:shadow-lg"
              >
                <div className={`mb-2.5 grid h-9 w-9 place-items-center rounded-lg ${f.bg} ${f.color} transition-transform group-hover:scale-110`}>
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <h3 className="text-sm font-semibold">{f.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {f.desc}
                </p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

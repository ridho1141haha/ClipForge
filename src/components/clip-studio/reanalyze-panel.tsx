'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { PLATFORMS } from '@/lib/youtube'
import { STYLE_PRESETS } from '@/lib/editplan'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  currentPlatform: string
  currentStyle: string
  currentTargetDuration: number
  currentCount: number
  onReanalyze: (platform: string, style: string, targetDuration: number, count: number) => void
  loading: boolean
}

export function ReanalyzePanel({
  open,
  onOpenChange,
  currentPlatform,
  currentStyle,
  currentTargetDuration,
  currentCount,
  onReanalyze,
  loading,
}: Props) {
  const [platform, setPlatform] = React.useState(currentPlatform)
  const [style, setStyle] = React.useState(currentStyle)
  const [targetDuration, setTargetDuration] = React.useState(currentTargetDuration)
  const [count, setCount] = React.useState(currentCount)

  React.useEffect(() => {
    if (open) {
      setPlatform(currentPlatform)
      setStyle(currentStyle)
      setTargetDuration(currentTargetDuration)
      setCount(currentCount)
    }
  }, [open, currentPlatform, currentStyle, currentTargetDuration, currentCount])

  if (!open) return null

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="mb-4 overflow-hidden rounded-xl border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold">Re-analyze with new settings</h4>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Re-run the AI with a different platform, editing style, or clip count. This will replace current suggestions.
      </p>

      <div className="mt-3 space-y-3">
        {/* platform */}
        <div>
          <Label className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Platform
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => {
              const active = platform === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPlatform(p.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card/60 text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  <span className="text-xs">{p.icon}</span>
                  {p.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* style */}
        <div>
          <Label className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Editing style
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {STYLE_PRESETS.map((s) => {
              const active = style === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStyle(s.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card/60 text-muted-foreground hover:border-primary/40'
                  }`}
                  title={s.desc}
                >
                  <span className="text-xs">{s.icon}</span>
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* count + duration */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <Label className="whitespace-nowrap text-[10px] text-muted-foreground">
              Clips
            </Label>
            <Slider
              value={[count]}
              min={3}
              max={10}
              step={1}
              onValueChange={(v) => setCount(v[0])}
              className="flex-1"
            />
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/10 text-xs font-semibold text-primary tabular-nums">
              {count}
            </span>
          </div>
          <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <Label className="whitespace-nowrap text-[10px] text-muted-foreground">
              Length
            </Label>
            <Slider
              value={[targetDuration]}
              min={15}
              max={120}
              step={5}
              onValueChange={(v) => setTargetDuration(v[0])}
              className="flex-1"
            />
            <span className="grid h-5 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-xs font-semibold text-primary tabular-nums">
              {targetDuration}s
            </span>
          </div>
        </div>

        {/* actions */}
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-8 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onReanalyze(platform, style, targetDuration, count)}
            disabled={loading}
            className="h-8 gap-1.5 text-xs"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {loading ? 'Analyzing…' : 'Re-analyze'}
          </Button>
        </div>
      </div>
    </motion.div>
  )
}

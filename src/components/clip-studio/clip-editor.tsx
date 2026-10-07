'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { X, Plus, Magnet, AudioLines } from 'lucide-react'
import { fmtTime, type SuggestedClip } from '@/lib/youtube'
import { snapToWordBoundary, type WordT } from '@/lib/word-snap'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  clip: SuggestedClip | null
  duration: number
  onSave: (clip: SuggestedClip) => void
}

export function ClipEditor({ open, onOpenChange, clip, duration, onSave }: Props) {
  const [draft, setDraft] = React.useState<SuggestedClip | null>(clip)
  const [tagInput, setTagInput] = React.useState('')
  const [snapOn, setSnapOn] = React.useState(true)
  const [snapHint, setSnapHint] = React.useState<string | null>(null)

  React.useEffect(() => {
    setDraft(clip ? { ...clip, tags: [...clip.tags] } : null)
    setTagInput('')
    setSnapHint(null)
    setSnapOn(true)
  }, [clip, open])

  if (!draft) return null

  const update = (patch: Partial<SuggestedClip>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d))

  const dur = draft.endTime - draft.startTime
  const words: WordT[] = (draft.clipWords ?? []).filter((w) => isFinite(w.start) && isFinite(w.end))
  const canSnap = snapOn && words.length >= 2

  const applyStart = (raw: number) => {
    const snapped = canSnap ? snapToWordBoundary(raw, words) : { time: raw, word: null }
    const ns = Math.min(Math.round(snapped.time * 10) / 10, draft.endTime - 1)
    update({ startTime: ns })
    setSnapHint(snapped.word ? `start snapped to speech: “${snapped.word}”` : null)
  }

  const applyEnd = (raw: number) => {
    const snapped = canSnap ? snapToWordBoundary(raw, words) : { time: raw, word: null }
    const ne = Math.max(Math.round(snapped.time * 10) / 10, draft.startTime + 1)
    update({ endTime: ne })
    setSnapHint(snapped.word ? `end snapped to speech: “${snapped.word}”` : null)
  }

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, '')
    if (!t) return
    if (!draft.tags.includes(t)) update({ tags: [...draft.tags, t] })
    setTagInput('')
  }

  const removeTag = (t: string) =>
    update({ tags: draft.tags.filter((x) => x !== t) })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <DialogTitle className="text-base">Edit clip</DialogTitle>
          <DialogDescription className="text-xs">
            Fine-tune the clip details. Times are in seconds.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto scrollbar-thin p-5">
          {/* title */}
          <div className="space-y-1.5">
            <Label htmlFor="clip-title" className="text-xs">
              Title
            </Label>
            <Input
              id="clip-title"
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              className="h-9"
            />
          </div>

          {/* hook */}
          <div className="space-y-1.5">
            <Label htmlFor="clip-hook" className="text-xs">
              Hook text
            </Label>
            <Textarea
              id="clip-hook"
              value={draft.hookText}
              onChange={(e) => update({ hookText: e.target.value })}
              className="resize-none"
              rows={2}
            />
          </div>

          {/* summary */}
          <div className="space-y-1.5">
            <Label htmlFor="clip-summary" className="text-xs">
              Summary / Why it's a highlight
            </Label>
            <Textarea
              id="clip-summary"
              value={draft.summary}
              onChange={(e) => update({ summary: e.target.value })}
              className="resize-none"
              rows={2}
            />
          </div>

          {/* time range */}
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Start: {fmtTime(draft.startTime)}</Label>
                <Slider
                  value={[draft.startTime]}
                  min={0}
                  max={Math.max(duration - 1, draft.startTime + 1)}
                  step={0.1}
                  onValueChange={(v) => applyStart(v[0])}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">End: {fmtTime(draft.endTime)}</Label>
                <Slider
                  value={[draft.endTime]}
                  min={Math.max(draft.startTime + 1, 1)}
                  max={duration}
                  step={0.1}
                  onValueChange={(v) => applyEnd(v[0])}
                />
              </div>
            </div>

            {/* word-boundary ruler (from REAL word timestamps) */}
            {words.length >= 2 && (
              <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
                <div className="relative h-3" title="Speech density from real word timestamps">
                  {words.map((w, i) => (
                    <span
                      key={i}
                      className="absolute top-0 h-3 w-px bg-primary/45"
                      style={{ left: `${Math.min(100, Math.max(0, ((w.start + w.end) / 2 - draft.startTime) / Math.max(dur, 0.001)) * 100)}%` }}
                    />
                  ))}
                  {/* clip window edges */}
                  <span className="absolute top-0 h-3 w-0.5 bg-emerald-500" style={{ left: 0 }} />
                  <span className="absolute top-0 h-3 w-0.5 bg-rose-500" style={{ left: '100%' }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <AudioLines className="h-3 w-3" />
                    speech boundaries ({words.length} words)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Magnet className={`h-3 w-3 ${canSnap ? 'text-primary' : 'text-muted-foreground/40'}`} />
                    <span className="text-muted-foreground">snap to speech</span>
                    <Switch checked={snapOn} onCheckedChange={setSnapOn} aria-label="Snap boundaries to speech" className="h-4 w-7 [&>span]:h-3 [&>span]:w-3" />
                  </span>
                </div>
                {snapHint && (
                  <p className="mt-1 text-[10px] font-medium text-primary">{snapHint}</p>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">Duration</span>
            <span className="font-mono tabular-nums">{fmtTime(dur)} ({dur.toFixed(0)}s)</span>
          </div>

          {/* score */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              Virality score: <span className="font-bold text-primary">{draft.score}</span>
            </Label>
            <Slider
              value={[draft.score]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => update({ score: v[0] })}
            />
          </div>

          {/* tags */}
          <div className="space-y-1.5">
            <Label className="text-xs">Tags</Label>
            <div className="flex flex-wrap gap-1.5">
              <AnimatePresence>
                {draft.tags.map((t) => (
                  <motion.div
                    key={t}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                  >
                    <Badge variant="secondary" className="gap-1">
                      #{t}
                      <button
                        onClick={() => removeTag(t)}
                        className="rounded-full hover:bg-destructive/20 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag()
                  }
                }}
                placeholder="Add tag…"
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={addTag}
                className="h-8 shrink-0 gap-1"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(draft)
              onOpenChange(false)
            }}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
import { X, Plus } from 'lucide-react'
import { fmtTime, type SuggestedClip } from '@/lib/youtube'

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

  React.useEffect(() => {
    setDraft(clip ? { ...clip, tags: [...clip.tags] } : null)
    setTagInput('')
  }, [clip, open])

  if (!draft) return null

  const update = (patch: Partial<SuggestedClip>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d))

  const dur = draft.endTime - draft.startTime

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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Start: {fmtTime(draft.startTime)}</Label>
              <Slider
                value={[draft.startTime]}
                min={0}
                max={Math.max(duration - 1, draft.startTime + 1)}
                step={1}
                onValueChange={(v) => {
                  const ns = Math.min(v[0], draft.endTime - 1)
                  update({ startTime: ns })
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">End: {fmtTime(draft.endTime)}</Label>
              <Slider
                value={[draft.endTime]}
                min={Math.max(draft.startTime + 1, 1)}
                max={duration}
                step={1}
                onValueChange={(v) => {
                  const ne = Math.max(v[0], draft.startTime + 1)
                  update({ endTime: ne })
                }}
              />
            </div>
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

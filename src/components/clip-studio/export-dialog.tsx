'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { FileJson, FileText, FileSpreadsheet, Film, Download, Copy, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { type SuggestedClip } from '@/lib/youtube'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string | null
  clips: SuggestedClip[]
  projectTitle: string
}

const FORMATS = [
  { id: 'json', label: 'JSON', desc: 'Full edit plan + transcript + scores', icon: FileJson },
  { id: 'csv', label: 'CSV', desc: 'Spreadsheet-friendly', icon: FileSpreadsheet },
  { id: 'srt', label: 'SRT', desc: 'Subtitles from real transcript', icon: FileText },
  { id: 'vtt', label: 'VTT', desc: 'WebVTT captions', icon: FileText },
  { id: 'edl', label: 'EDL', desc: 'Edit decision list (with cuts)', icon: Film },
] as const

export function ExportDialog({
  open,
  onOpenChange,
  projectId,
  clips,
  projectTitle,
}: Props) {
  const [format, setFormat] = React.useState<'json' | 'csv' | 'srt' | 'vtt' | 'edl'>('json')
  const [downloading, setDownloading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [preview, setPreview] = React.useState('')

  // Build preview text from clips directly (no backend call) for instant feedback
  React.useEffect(() => {
    if (!open) return
    setPreview(buildPreview(clips, projectTitle, format))
  }, [open, clips, projectTitle, format])

  const handleDownload = async () => {
    if (!projectId) return
    setDownloading(true)
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, format }),
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('content-disposition') ?? ''
      const m = cd.match(/filename="([^"]+)"/)
      a.download = m?.[1] ?? `clipforge-export.${format}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(preview)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 p-5 pb-4">
          <DialogTitle className="text-base">Export clips</DialogTitle>
          <DialogDescription className="text-xs">
            Download the approved clip list in your preferred format.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 p-5">
          {/* format picker */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FORMATS.map((f) => {
              const active = format === f.id
              const Icon = f.icon
              return (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all ${
                    active
                      ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  <Icon
                    className={`h-5 w-5 ${active ? 'text-primary' : 'text-muted-foreground'}`}
                  />
                  <span className="text-sm font-semibold">{f.label}</span>
                  <span className="text-[10px] text-muted-foreground">{f.desc}</span>
                </button>
              )
            })}
          </div>

          {/* preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Preview ({clips.length} clips)
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopy}
                className="h-7 gap-1.5 text-xs"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-500" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <pre className="max-h-56 overflow-auto scrollbar-thin rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <code className="font-mono">{preview || 'Nothing to preview yet.'}</code>
            </pre>
          </div>

          {!projectId && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Save the project to library first to enable file download. You can still copy the preview.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={handleDownload} disabled={!projectId || downloading} className="gap-2">
            {downloading ? (
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                className="inline-block h-4 w-4 rounded-full border-2 border-primary-foreground border-t-transparent"
              />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download .{format}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function buildPreview(clips: SuggestedClip[], title: string, format: string): string {
  if (clips.length === 0) return 'No clips to export.'
  if (format === 'json') {
    return JSON.stringify(
      clips.map((c, i) => ({
        index: i + 1,
        title: c.title,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: +(c.endTime - c.startTime).toFixed(1),
        score: c.score,
        hookText: c.hookText,
        tags: c.tags,
      })),
      null,
      2,
    ).slice(0, 1500)
  }
  if (format === 'csv') {
    const rows = [['index', 'title', 'start', 'end', 'score', 'hook']]
    clips.forEach((c, i) =>
      rows.push([
        String(i + 1),
        c.title.replace(/,/g, ';'),
        String(c.startTime),
        String(c.endTime),
        String(c.score),
        (c.hookText ?? '').replace(/,/g, ';'),
      ]),
    )
    return rows.map((r) => r.join(',')).join('\n')
  }
  if (format === 'srt' || format === 'vtt') {
    const prefix = format === 'vtt' ? 'WEBVTT\n\n' : ''
    return (
      prefix +
      clips
        .map((c, i) => `${i + 1}\n${srt(c.startTime)} --> ${srt(c.endTime)}\n${c.spokenHook ?? c.hookText ?? c.title}`)
        .join('\n\n')
    ).slice(0, 1500) + '\n\n[server export uses REAL transcript word timestamps + output-time mapping]'
  }
  // edl-ish
  const lines = [`TITLE: ${title}`, '']
  clips.forEach((c, i) => {
    lines.push(`${String(i + 1).padStart(3, '0')}  AX  AA/V  C        ${edl(c.startTime)} ${edl(c.endTime)}`)
    lines.push(`* FROM CLIP NAME: ${c.title}`)
    if (c.hookText) lines.push(`* COMMENT: ${c.hookText}`)
    lines.push('')
  })
  return lines.join('\n').slice(0, 1500)
}

function srt(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(si)},${p(ms, 3)}`
}

function edl(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const si = Math.floor(s % 60)
  const f = Math.round((s - Math.floor(s)) * 30)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(si)}:${p(f)}`
}

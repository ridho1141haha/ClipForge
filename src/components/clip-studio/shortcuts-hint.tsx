'use client'

import * as React from 'react'
import { Keyboard } from 'lucide-react'

const SHORTCUTS = [
  { keys: ['J'], label: 'Prev clip' },
  { keys: ['K'], label: 'Next clip' },
  { keys: ['A'], label: 'Approve' },
  { keys: ['R'], label: 'Reject' },
  { keys: ['U'], label: 'Reset' },
  { keys: ['E'], label: 'Edit' },
  { keys: ['P'], label: 'AI plan' },
  { keys: ['Space'], label: 'Preview' },
  { keys: ['D'], label: 'Duplicate' },
  { keys: ['S'], label: 'Split' },
  { keys: ['Esc'], label: 'Clear sel' },
]

export function ShortcutsHint() {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        aria-label="Keyboard shortcuts"
      >
        <Keyboard className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Shortcuts</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border bg-popover p-2 shadow-xl">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Keyboard shortcuts
          </p>
          <div className="grid grid-cols-2 gap-1">
            {SHORTCUTS.map((s) => (
              <div
                key={s.label}
                className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs text-muted-foreground"
              >
                <span>{s.label}</span>
                <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-semibold text-foreground">
                  {s.keys.join('')}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

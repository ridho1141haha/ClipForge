'use client'

import * as React from 'react'
import { useToast } from '@/hooks/use-toast'

// ---------------------------------------------------------------------------
// RenderNotifier — page-level, tab-independent render completion watcher.
//
// RenderHistory only polls while the Render tab is mounted, so a render that
// finished while the user was on the Studio/Library tab completed silently.
// This headless component lifts the transition watcher to the PAGE level:
//   • 4s polls while any owned job is ACTIVE (real renderer progress)
//   • 45s heartbeat otherwise (catches renders started in other tabs of the
//     same session — cheap: one owner-scoped JSON round trip)
//   • toast on active → DONE / ERROR transitions; NEVER on the first load
//     (opening the page must not toast for already-old jobs)
//   • polling PAUSES while the browser tab is hidden (document.hidden) —
//     background-tab polling is pure waste; returning to the tab polls
//     immediately, so a render that finished while hidden still toasts.
// RenderHistory keeps its own display polling but no longer toasts — this is
// the single toast source, so a transition is never double-notified.
// ---------------------------------------------------------------------------

const ACTIVE: string[] = ['QUEUED', 'EXTRACTING', 'RENDERING', 'FINALIZING']

interface HistoryRow {
  id: string
  status: string
  filename: string | null
  stage: string | null
}

export function RenderNotifier() {
  const { toast } = useToast()
  const seenRef = React.useRef<Map<string, string>>(new Map())
  const initializedRef = React.useRef(false)
  const timerRef = React.useRef<number>(0)

  React.useEffect(() => {
    let cancelled = false

    const schedule = (ms: number) => {
      window.clearTimeout(timerRef.current)
      // hidden tab → no timer at all; the visibilitychange handler below
      // resumes polling (immediately) when the tab returns
      if (typeof document !== 'undefined' && document.hidden) return
      timerRef.current = window.setTimeout(() => void poll(), ms)
    }

    const poll = async () => {
      let next: HistoryRow[] | null = null
      try {
        const res = await fetch('/api/render-proxy/jobs', { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { jobs?: HistoryRow[] }
          next = data.jobs ?? []
        }
      } catch {
        // offline / dev recompile — retry on the next tick
      }
      if (cancelled) return
      if (next) {
        if (initializedRef.current) {
          for (const j of next) {
            const prev = seenRef.current.get(j.id)
            if (prev && ACTIVE.includes(prev)) {
              if (j.status === 'DONE') {
                toast({
                  title: 'Render complete',
                  description: `${j.filename ?? 'Your clip'} is ready to download in Render history.`,
                })
              } else if (j.status === 'ERROR') {
                toast({
                  title: 'Render failed',
                  description: j.stage ?? 'The render ended with an error.',
                  variant: 'destructive',
                })
              }
              // CANCELLED is user-initiated — no notification
            }
          }
        }
        for (const j of next) seenRef.current.set(j.id, j.status)
        initializedRef.current = true
        const anyActive = next.some((j) => ACTIVE.includes(j.status))
        schedule(anyActive ? 4000 : 45_000)
      } else {
        schedule(30_000)
      }
    }

    const onVisibility = () => {
      if (cancelled) return
      if (document.hidden) {
        window.clearTimeout(timerRef.current)
      } else {
        void poll() // immediate refresh — catch up on what changed while hidden
      }
    }

    schedule(3000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [toast])

  return null
}

'use client'

import * as React from 'react'
import { isRenderQuality, type RenderQuality } from '@/lib/render-recipe'

// ---------------------------------------------------------------------------
// useRenderQuality — the session-wide render-quality preference, with an
// optional PER-PROJECT override.
//
// Storage model (localStorage):
//   clipforge-render-quality            — the global default (last choice)
//   clipforge-render-quality:p:<id>     — a project-specific override
//
// Reads prefer the per-project value (when the consumer passes a projectId)
// and fall back to the global default. Writes update the per-project key AND
// the global default (the last choice becomes the default for new projects),
// so the single-render selector and the batch-render selector — both bound to
// the same project — never disagree.
//
// Cross-consumer sync uses a CustomEvent carrying { quality, projectId }.
// On receive: an event from the SAME project scope applies directly; an event
// from a DIFFERENT project only affects this consumer through the global
// default, so the effective value is re-read from storage.
// Unknown/corrupt stored values fall back to 'standard' — the historical
// default render.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'clipforge-render-quality'
const EVENT = 'clipforge:quality-change'

function projectKey(projectId: string): string {
  return `${STORAGE_KEY}:p:${projectId}`
}

function readStored(key: string): RenderQuality | null {
  try {
    const saved = window.localStorage.getItem(key)
    return isRenderQuality(saved) ? saved : null
  } catch {
    return null
  }
}

function readEffective(projectId: string | null | undefined): RenderQuality {
  if (typeof window === 'undefined') return 'standard'
  if (projectId) {
    const perProject = readStored(projectKey(projectId))
    if (perProject) return perProject
  }
  return readStored(STORAGE_KEY) ?? 'standard'
}

export function useRenderQuality(
  projectId?: string | null,
): [RenderQuality, (q: RenderQuality) => void] {
  const [quality, setQuality] = React.useState<RenderQuality>(() => readEffective(projectId))

  // a project switch re-reads the effective value (per-project override or
  // the global default) — the selector follows the active project
  React.useEffect(() => {
    setQuality(readEffective(projectId))
  }, [projectId])

  // stay in sync with other consumers (single ↔ batch selectors)
  React.useEffect(() => {
    const onExternal = (e: Event) => {
      const detail = (e as CustomEvent<{ quality: RenderQuality; projectId: string | null }>).detail
      if (!isRenderQuality(detail?.quality)) return
      if (!detail.projectId || detail.projectId === projectId) {
        // same scope (or a global change) — apply directly
        setQuality(detail.quality)
      } else {
        // a different project's choice updated the global default — my
        // effective value may have changed (unless I have my own override)
        setQuality(readEffective(projectId))
      }
    }
    window.addEventListener(EVENT, onExternal)
    return () => window.removeEventListener(EVENT, onExternal)
  }, [projectId])

  const select = React.useCallback(
    (q: RenderQuality) => {
      setQuality(q)
      try {
        window.localStorage.setItem(STORAGE_KEY, q)
        if (projectId) window.localStorage.setItem(projectKey(projectId), q)
      } catch {
        // private browsing / storage disabled — session-only preference
      }
      window.dispatchEvent(
        new CustomEvent(EVENT, { detail: { quality: q, projectId: projectId ?? null } }),
      )
    },
    [projectId],
  )

  return [quality, select]
}

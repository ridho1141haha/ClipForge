'use client'

import * as React from 'react'
import { isRenderQuality, type RenderQuality } from '@/lib/render-recipe'

// ---------------------------------------------------------------------------
// useRenderQuality — the single session-wide render-quality preference.
//
// Persisted in localStorage ('clipforge-render-quality') and broadcast to
// every mounted consumer via a CustomEvent, so the single-render selector and
// the batch-render selector (both visible on the Render tab) never disagree.
// Unknown/corrupt stored values fall back to 'standard' — the historical
// default render.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'clipforge-render-quality'
const EVENT = 'clipforge:quality-change'

export function useRenderQuality(): [RenderQuality, (q: RenderQuality) => void] {
  const [quality, setQuality] = React.useState<RenderQuality>(() => {
    if (typeof window === 'undefined') return 'standard'
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      return isRenderQuality(saved) ? saved : 'standard'
    } catch {
      return 'standard'
    }
  })

  // stay in sync with other consumers (single ↔ batch selectors)
  React.useEffect(() => {
    const onExternal = (e: Event) => {
      const q = (e as CustomEvent<RenderQuality>).detail
      if (isRenderQuality(q)) setQuality(q)
    }
    window.addEventListener(EVENT, onExternal)
    return () => window.removeEventListener(EVENT, onExternal)
  }, [])

  const select = React.useCallback((q: RenderQuality) => {
    setQuality(q)
    try {
      window.localStorage.setItem(STORAGE_KEY, q)
    } catch {
      // private browsing / storage disabled — session-only preference
    }
    window.dispatchEvent(new CustomEvent<RenderQuality>(EVENT, { detail: q }))
  }, [])

  return [quality, select]
}

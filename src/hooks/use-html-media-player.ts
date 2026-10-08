'use client'

import * as React from 'react'

/**
 * HTML5 <video> player handle — mirrors the interface of useYouTubePlayer's
 * YouTubePlayerHandle so player components can be backed by either source.
 *
 * The source URL is the owner-scoped streaming endpoint
 * `/api/media/[projectId]`, which honors HTTP Range requests (206) so the
 * browser can seek instantly without downloading the whole file.
 */
export interface HtmlMediaPlayerHandle {
  play: () => void
  pause: () => void
  seekTo: (sec: number) => void
  getCurrentTime: () => number
  getDuration: () => number
  setPlaybackRate: (rate: number) => void
  /** Real mute toggle (mirrors YouTubePlayerHandle) */
  setMuted: (muted: boolean) => void
  /** 1 = playing, 2 = paused (YouTube state convention), 0 = not started */
  getPlayerState: () => number
  isReady: boolean
  /** 404/409/410-style media load failure — caller should fall back or show UI */
  error: string | null
}

/**
 * Attach these props to a <video> element to bind the handle.
 * The hook owns the element via ref; `videoProps` spreads the ref + events.
 */
export function useHtmlMediaPlayer(src: string | null): {
  handle: HtmlMediaPlayerHandle
  videoRef: React.RefObject<HTMLVideoElement | null>
  videoProps: {
    ref: React.RefObject<HTMLVideoElement | null>
    src: string | undefined
    onLoadedMetadata: () => void
    onError: () => void
  }
} {
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const [isReady, setIsReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Reset readiness whenever the source changes (or is removed)
  React.useEffect(() => {
    setIsReady(false)
    setError(null)
  }, [src])

  const onLoadedMetadata = React.useCallback(() => {
    setIsReady(true)
    setError(null)
  }, [])

  const onError = React.useCallback(() => {
    const el = videoRef.current
    const code = el?.error?.code
    const reason =
      code === 4
        ? 'Source media could not be loaded (missing, blocked, or unsupported format).'
        : code === 2
          ? 'Network error while fetching source media.'
          : code === 3
            ? 'Source media decode failed.'
            : 'Source media error.'
    setError(reason)
    setIsReady(false)
  }, [])

  const handle = React.useMemo<HtmlMediaPlayerHandle>(
    () => ({
      play: () => {
        const el = videoRef.current
        if (el) el.play().catch(() => {/* autoplay rejection is fine — user gesture will resume */})
      },
      pause: () => {
        videoRef.current?.pause()
      },
      seekTo: (sec: number) => {
        const el = videoRef.current
        if (!el) return
        // Guard NaN — seeking to NaN throws in some browsers
        if (!Number.isFinite(sec)) return
        try {
          el.currentTime = Math.max(0, sec)
        } catch {}
      },
      getCurrentTime: () => videoRef.current?.currentTime ?? 0,
      getDuration: () => {
        const d = videoRef.current?.duration
        return typeof d === 'number' && Number.isFinite(d) ? d : 0
      },
      setPlaybackRate: (rate: number) => {
        const el = videoRef.current
        if (el) el.playbackRate = rate
      },
      setMuted: (muted: boolean) => {
        const el = videoRef.current
        if (el) el.muted = muted
      },
      getPlayerState: () => {
        const el = videoRef.current
        if (!el) return 0
        return el.paused ? 2 : 1
      },
      isReady,
      error,
    }),
    [isReady, error],
  )

  const videoProps = React.useMemo(
    () => ({
      ref: videoRef,
      src: src ?? undefined,
      onLoadedMetadata,
      onError,
    }),
    [src, onLoadedMetadata, onError],
  )

  return { handle, videoRef, videoProps }
}

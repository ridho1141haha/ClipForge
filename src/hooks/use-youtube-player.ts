'use client'

import * as React from 'react'

// Minimal YouTube IFrame API typings
declare global {
  interface Window {
    YT?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<void> | null = null

function loadYouTubeAPI(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.YT && window.YT.Player) return Promise.resolve()
  if (apiPromise) return apiPromise
  apiPromise = new Promise<void>((resolve) => {
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      resolve()
    }
    document.head.appendChild(tag)
  })
  return apiPromise
}

export interface YouTubePlayerHandle {
  play: () => void
  pause: () => void
  seekTo: (sec: number) => void
  getCurrentTime: () => number
  getDuration: () => number
  setPlaybackRate: (rate: number) => void
  getPlayerState: () => number
  /** Real mute toggle (the old mute button incorrectly paused playback) */
  setMuted: (muted: boolean) => void
  isReady: boolean
}

export function useYouTubePlayer(
  containerId: string,
  videoId: string | null,
  onReady?: () => void,
  onStateChange?: (state: number) => void,
) {
  const [player, setPlayer] = React.useState<any>(null)
  const [isReady, setIsReady] = React.useState(false)
  const playerRef = React.useRef<any>(null)

  React.useEffect(() => {
    if (!videoId) return
    let cancelled = false
    loadYouTubeAPI().then(() => {
      if (cancelled) return
      // destroy old player
      if (playerRef.current && playerRef.current.destroy) {
        try {
          playerRef.current.destroy()
        } catch {}
        playerRef.current = null
        setPlayer(null)
        setIsReady(false)
      }
      const el = document.getElementById(containerId)
      if (!el) return
      const p = new window.YT.Player(containerId, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (cancelled) return
            playerRef.current = p
            setPlayer(p)
            setIsReady(true)
            onReady?.()
          },
          onStateChange: (e: any) => {
            onStateChange?.(e.data)
          },
        },
      })
    })
    return () => {
      cancelled = true
      if (playerRef.current && playerRef.current.destroy) {
        try {
          playerRef.current.destroy()
        } catch {}
      }
      playerRef.current = null
    }
  }, [videoId, containerId])

  const handle = React.useMemo<YouTubePlayerHandle>(
    () => ({
      play: () => player?.playVideo?.(),
      pause: () => player?.pauseVideo?.(),
      seekTo: (sec: number) => player?.seekTo?.(sec, true),
      getCurrentTime: () => player?.getCurrentTime?.() ?? 0,
      getDuration: () => player?.getDuration?.() ?? 0,
      setPlaybackRate: (rate: number) => player?.setPlaybackRate?.(rate),
      getPlayerState: () => player?.getPlayerState?.() ?? -1,
      setMuted: (muted: boolean) => {
        if (muted) player?.mute?.()
        else player?.unMute?.()
      },
      isReady,
    }),
    [player, isReady],
  )

  return handle
}

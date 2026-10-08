'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Sparkles,
  Zap,
  HardDrive,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { fmtTime } from '@/lib/youtube'
import {
  buildRenderRecipe,
  scaleAtTime,
  isInCut,
  subtitleAtTime,
  segmentAtTime,
  visualAtTime,
  playSoundEffect,
  type RenderRecipe,
} from '@/lib/render-recipe'
import type { EditPlan } from '@/lib/editplan'
import { useYouTubePlayer } from '@/hooks/use-youtube-player'
import { useHtmlMediaPlayer } from '@/hooks/use-html-media-player'

interface Props {
  plan: EditPlan | null
  youtubeId: string
  /** Owner-scoped stream URL (/api/media/[projectId]) — when present the
   *  preview plays the REAL downloaded source instead of the YouTube iframe. */
  mediaUrl?: string | null
  open: boolean
  onClose: () => void
}

export function AutoEditPlayer({ plan, youtubeId, mediaUrl, open, onClose }: Props) {
  const recipe = React.useMemo(() => (plan ? buildRenderRecipe(plan, youtubeId) : null), [plan, youtubeId])

  // --- dual player backends ---
  const media = useHtmlMediaPlayer(open && mediaUrl ? mediaUrl : null)
  const usingMedia = !!mediaUrl && !media.handle.error
  const yt = useYouTubePlayer('auto-edit-player', open && youtubeId && !usingMedia ? youtubeId : null)
  const player = usingMedia ? media.handle : yt

  const [playing, setPlaying] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [rate, setRate] = React.useState(1)
  const [muted, setMuted] = React.useState(false)
  const [started, setStarted] = React.useState(false)
  const [sfxPlayed, setSfxPlayed] = React.useState<Set<string>>(new Set())
  const [lastCutTime, setLastCutTime] = React.useState<number | null>(null)
  const audioCtxRef = React.useRef<AudioContext | null>(null)

  // Effect: apply mute to the active backend (real mute — not pause)
  React.useEffect(() => {
    if (!open) return
    player.setMuted?.(muted)
  }, [open, muted, usingMedia, player.isReady])

  // Poll current time at 30fps
  React.useEffect(() => {
    if (!open || !player.isReady) return
    let raf = 0
    const tick = () => {
      const t = player.getCurrentTime()
      setCurrentTime(t)
      // cut skipping
      if (recipe) {
        const { cut } = isInCut(t, recipe.cuts)
        if (cut && (lastCutTime === null || t < lastCutTime || t > lastCutTime + 0.5)) {
          // entered a cut -> seek to end of cut
          player.seekTo(cut.end)
          setLastCutTime(cut.end)
        }
        // play sound effects at the right time
        for (const sfx of recipe.soundEffects) {
          const key = `${sfx.start}-${sfx.type}`
          if (t >= sfx.start && t < sfx.start + 0.5 && !sfxPlayed.has(key)) {
            if (!muted && audioCtxRef.current) {
              playSoundEffect(audioCtxRef.current, sfx.type, sfx.intensity)
            }
            setSfxPlayed((prev) => new Set(prev).add(key))
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, player, recipe, muted, sfxPlayed, lastCutTime])

  // init audio context on first user gesture
  const ensureAudio = React.useCallback(() => {
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
      } catch {}
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume()
    }
  }, [])

  const startPlayback = React.useCallback(() => {
    if (!player.isReady || !recipe) return
    ensureAudio()
    setStarted(true)
    // seek to clip start
    player.seekTo(recipe.clipStart)
    player.setPlaybackRate(rate)
    player.play()
    setPlaying(true)
    setSfxPlayed(new Set())
    setLastCutTime(null)
  }, [player, recipe, rate, ensureAudio])

  const togglePlay = React.useCallback(() => {
    if (!player.isReady) return
    if (!started) {
      startPlayback()
      return
    }
    if (playing) {
      player.pause()
      setPlaying(false)
    } else {
      ensureAudio()
      player.play()
      setPlaying(true)
    }
  }, [player, playing, started, startPlayback, ensureAudio])

  const restart = React.useCallback(() => {
    if (!player.isReady || !recipe) return
    player.seekTo(recipe.clipStart)
    player.play()
    setPlaying(true)
    setSfxPlayed(new Set())
    setLastCutTime(null)
  }, [player, recipe])

  const seekTo = React.useCallback(
    (sec: number) => {
      if (!player.isReady || !recipe) return
      const clamped = Math.max(recipe.clipStart, Math.min(recipe.clipEnd, sec))
      player.seekTo(clamped)
      setSfxPlayed((prev) => {
        const next = new Set(prev)
        // remove sfx keys after the seek target so they can replay
        for (const key of next) {
          const t = Number(key.split('-')[0])
          if (t >= clamped) next.delete(key)
        }
        return next
      })
    },
    [player, recipe],
  )

  const changeRate = (r: number) => {
    setRate(r)
    player.setPlaybackRate(r)
  }

  if (!open || !recipe) return null

  // current state
  const inClip = currentTime >= recipe.clipStart && currentTime <= recipe.clipEnd
  const currentScale = scaleAtTime(currentTime, recipe.cameraKeyframes)
  const currentSubtitle = subtitleAtTime(currentTime, recipe.subtitles)
  const currentSegment = segmentAtTime(currentTime, recipe.segments)
  const currentVisual = visualAtTime(currentTime, recipe.visuals)
  const progress = recipe.duration > 0 ? Math.max(0, Math.min(1, (currentTime - recipe.clipStart) / recipe.duration)) : 0

  const segmentColors: Record<string, string> = {
    HOOK: 'bg-rose-500',
    CONTEXT: 'bg-sky-500',
    DEVELOPMENT: 'bg-violet-500',
    EXAMPLE: 'bg-amber-500',
    CONTRAST: 'bg-orange-500',
    PAYOFF: 'bg-emerald-500',
    CTA: 'bg-cyan-500',
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 12 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-border/60 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Auto-Edit Preview</h3>
            <Badge variant="secondary" className="text-[10px]">
              {recipe.title.slice(0, 40)}
            </Badge>
            {usingMedia ? (
              <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 text-[10px] dark:text-emerald-400">
                <HardDrive className="h-3 w-3" />
                local source · real cut preview
              </Badge>
            ) : (
              <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600 text-[10px] dark:text-amber-400" title="The downloaded source file is unavailable — previewing an approximation via the YouTube embed">
                YouTube approximation
              </Badge>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} className="h-7 text-xs">
            Close
          </Button>
        </div>

        <div className="grid gap-0 md:grid-cols-[1fr_280px]">
          {/* player */}
          <div className="relative bg-black">
            <div
              className="relative mx-auto aspect-video max-h-[60vh] w-full overflow-hidden"
              style={{ aspectRatio: '9 / 16', maxWidth: 'calc((60vh) * 9 / 16)' }}
            >
              {/* The iframe / video is scaled to simulate punch-in */}
              <div
                style={{
                  transform: `scale(${currentScale})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.15s linear',
                  width: '100%',
                  height: '100%',
                }}
              >
                {usingMedia ? (
                  <video
                    {...media.videoProps}
                    className="h-full w-full object-cover object-center"
                    controls={false}
                    playsInline
                    preload="auto"
                    disablePictureInPicture
                    onSeeked={() => {
                      // after a programmatic seek past a cut, resume playback
                      if (playing) media.handle.play()
                    }}
                  />
                ) : (
                  <div id="auto-edit-player" className="h-full w-full" />
                )}
              </div>

              {/* overlay: subtitle */}
              <AnimatePresence>
                {currentSubtitle && (
                  <motion.div
                    key={currentSubtitle.start}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute bottom-16 left-1/2 w-[90%] -translate-x-1/2 text-center"
                  >
                    <span className="inline-block rounded bg-black/80 px-3 py-1.5 text-base font-bold text-white shadow-lg backdrop-blur-sm">
                      {renderEmphasis(currentSubtitle.text, currentSubtitle.emphasis_words, currentSubtitle.emphasis_type)}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* overlay: segment badge */}
              {currentSegment && inClip && (
                <div className="absolute left-3 top-3">
                  <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-white ${segmentColors[currentSegment.type] ?? 'bg-muted'}`}>
                    {currentSegment.type}
                  </span>
                </div>
              )}

              {/* overlay: visual card */}
              <AnimatePresence>
                {currentVisual && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="pointer-events-none absolute inset-x-4 top-1/4"
                  >
                    <div className="rounded-xl border border-white/30 bg-black/70 p-3 backdrop-blur-md">
                      <Badge variant="secondary" className="mb-1 text-[10px]">
                        {currentVisual.type}
                      </Badge>
                      <p className="text-xs font-medium text-white">{currentVisual.purpose}</p>
                      <p className="mt-1 text-[11px] italic text-white/70">{currentVisual.prompt}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* overlay: hook card at start */}
              <AnimatePresence>
                {recipe.generatedHook && currentTime < recipe.clipStart + 3 && started && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute inset-x-4 top-1/2 -translate-y-1/2 text-center"
                  >
                    <motion.span
                      animate={{ scale: [1, 1.05, 1] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                      className="inline-block rounded-xl bg-primary px-5 py-3 text-lg font-extrabold text-primary-foreground shadow-2xl"
                    >
                      {recipe.generatedHook}
                    </motion.span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* media load failure (fallback active) — explain honestly */}
              {mediaUrl && media.handle.error && (
                <div className="absolute inset-x-3 top-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Local source unavailable ({media.handle.error}) — fell back to the YouTube embed.
                  </span>
                </div>
              )}

              {/* "skipping cut" indicator */}
              {!inClip && started && (
                <div className="absolute inset-0 grid place-items-center bg-black/60">
                  <div className="flex items-center gap-2 rounded-lg bg-amber-500/20 px-3 py-2 text-sm text-amber-200">
                    <Zap className="h-4 w-4" />
                    Seeking to clip start…
                  </div>
                </div>
              )}

              {/* cut-skip flash */}
              {lastCutTime !== null && Math.abs(currentTime - lastCutTime) < 0.5 && (
                <motion.div
                  initial={{ opacity: 0.8 }}
                  animate={{ opacity: 0 }}
                  className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 bg-amber-500/30 py-1 text-center text-[10px] font-bold uppercase tracking-widest text-amber-100"
                >
                  cut skipped
                </motion.div>
              )}
            </div>

            {/* progress + controls */}
            <div className="border-t border-border/60 bg-card/40 p-3">
              {/* progress bar with segment + cut markers */}
              <div className="relative mb-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${progress * 100}%` }} />
                {/* segment markers */}
                {recipe.segments.map((s, i) => (
                  <div
                    key={i}
                    className={`absolute top-0 h-full w-px ${segmentColors[s.type] ?? 'bg-muted-foreground'} opacity-50`}
                    style={{ left: `${((s.start - recipe.clipStart) / recipe.duration) * 100}%` }}
                  />
                ))}
                {/* cut regions */}
                {recipe.cuts.map((c, i) => (
                  <div
                    key={i}
                    className="absolute top-0 h-full bg-rose-500/40"
                    style={{
                      left: `${((c.start - recipe.clipStart) / recipe.duration) * 100}%`,
                      width: `${((c.end - c.start) / recipe.duration) * 100}%`,
                    }}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Button size="icon" variant="ghost" className="h-9 w-9" onClick={togglePlay} disabled={!player.isReady}>
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <Button size="icon" variant="ghost" className="h-9 w-9" onClick={restart} disabled={!player.isReady} title="Restart">
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9"
                  onClick={() => seekTo(currentTime - 5)}
                  disabled={!player.isReady}
                  title="Back 5s"
                >
                  <SkipBack className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9"
                  onClick={() => seekTo(currentTime + 5)}
                  disabled={!player.isReady}
                  title="Forward 5s"
                >
                  <SkipForward className="h-4 w-4" />
                </Button>

                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {fmtTime(Math.max(0, currentTime - recipe.clipStart))} / {fmtTime(recipe.duration)}
                </span>

                <div className="ml-auto flex items-center gap-1">
                  {[0.5, 1, 1.5, 2].map((r) => (
                    <button
                      key={r}
                      onClick={() => changeRate(r)}
                      className={`h-7 w-8 rounded text-[11px] font-medium tabular-nums ${
                        rate === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {r}×
                    </button>
                  ))}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9"
                    onClick={() => setMuted((m) => !m)}
                    title={muted ? 'Unmute' : 'Mute'}
                  >
                    {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              {/* seek slider */}
              <Slider
                value={[Math.max(0, Math.min(recipe.duration, currentTime - recipe.clipStart))]}
                min={0}
                max={Math.max(0.1, recipe.duration)}
                step={0.1}
                onValueChange={(v) => seekTo(recipe.clipStart + v[0])}
                className="mt-2"
              />
            </div>
          </div>

          {/* side panel: live state */}
          <div className="border-l border-border/60 bg-card/30 p-3 text-xs">
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Live Edit State
            </h4>

            <div className="space-y-2">
              <StateRow label="Source time" value={fmtTime(currentTime)} />
              <StateRow label="Clip progress" value={`${Math.round(progress * 100)}%`} />
              <StateRow label="Camera scale" value={`${currentScale.toFixed(2)}×`} accent={currentScale > 1.02 ? 'violet' : undefined} />
              <StateRow label="In cut" value={isInCut(currentTime, recipe.cuts).cut ? 'YES (skipping)' : 'no'} accent={isInCut(currentTime, recipe.cuts).cut ? 'rose' : undefined} />

              <div className="border-t border-border/40 pt-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Current segment
                </p>
                {currentSegment ? (
                  <div>
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase text-white ${segmentColors[currentSegment.type] ?? 'bg-muted'}`}>
                      {currentSegment.type}
                    </span>
                    <p className="mt-1 text-[11px] text-foreground/80">{currentSegment.purpose}</p>
                  </div>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </div>

              <div className="border-t border-border/40 pt-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Active subtitle
                </p>
                {currentSubtitle ? (
                  <p className="rounded bg-primary/5 px-2 py-1 text-[11px] italic">{currentSubtitle.text}</p>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </div>

              <div className="border-t border-border/40 pt-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Active visual
                </p>
                {currentVisual ? (
                  <p className="text-[11px]">
                    <Badge variant="secondary" className="text-[9px]">{currentVisual.type}</Badge>
                    <span className="ml-1 text-foreground/80">{currentVisual.purpose}</span>
                  </p>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </div>

              <div className="border-t border-border/40 pt-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Plan summary
                </p>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                  <span>Segments: {recipe.segments.length}</span>
                  <span>Cuts: {recipe.cuts.length}</span>
                  <span>Subtitles: {recipe.subtitles.length}</span>
                  <span>Visuals: {recipe.visuals.length}</span>
                  <span>Camera: {recipe.cameraKeyframes.length / 2}</span>
                  <span>SFX: {recipe.soundEffects.length}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

function StateRow({ label, value, accent }: { label: string; value: string; accent?: 'violet' | 'rose' }) {
  const cls = accent === 'violet' ? 'text-violet-500' : accent === 'rose' ? 'text-rose-500' : 'text-foreground'
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${cls}`}>{value}</span>
    </div>
  )
}

function renderEmphasis(text: string, words: string[], type?: string) {
  if (!words || words.length === 0) return text
  const lower = text.toLowerCase()
  const matches: { start: number; end: number }[] = []
  words.forEach((w) => {
    const wl = w.toLowerCase()
    let idx = lower.indexOf(wl)
    while (idx !== -1) {
      matches.push({ start: idx, end: idx + w.length })
      idx = lower.indexOf(wl, idx + 1)
    }
  })
  matches.sort((a, b) => a.start - b.start)
  let cursor = 0
  const seen = new Set<number>()
  const parts: React.ReactNode[] = []
  matches.forEach((m, i) => {
    if (m.start < cursor || seen.has(m.start)) return
    parts.push(text.slice(cursor, m.start))
    let cls = 'text-amber-400 font-extrabold'
    if (type === 'uppercase') cls = 'uppercase text-amber-400 font-extrabold'
    else if (type === 'color') cls = 'text-rose-400 font-extrabold'
    else if (type === 'pop') cls = 'text-amber-300 text-lg font-extrabold'
    parts.push(
      <span key={i} className={cls}>
        {text.slice(m.start, m.end)}
      </span>,
    )
    cursor = m.end
    seen.add(m.start)
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

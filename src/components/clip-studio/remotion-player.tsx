'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Player, type PlayerRef } from '@remotion/player'
import {
  AbsoluteFill,
  Sequence,
  Video,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion'
import {
  X,
  Play,
  Pause,
  RotateCcw,
  Download,
  Sparkles,
  Scissors,
  Camera,
  Type,
  Volume2,
  Film,
  HardDrive,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { buildRenderRecipe, scaleAtTime } from '@/lib/render-recipe'
import { mapKeepRanges, sourceTimeAtOutput, type KeepRange } from '@/lib/keep-ranges'
import type { EditPlan, EditSegment } from '@/lib/editplan'
import { fmtTime } from '@/lib/youtube'

interface Props {
  open: boolean
  onClose: () => void
  plan: EditPlan | null
  youtubeId: string
  /** Owner-scoped stream URL — when present the Remotion composition renders
   *  a TRUE keep-range preview (cuts actually removed) from the real source. */
  mediaUrl?: string | null
}

// Convert absolute source timestamps to relative-to-clip frames
const FPS = 30

export function RemotionPlayer({ open, onClose, plan, youtubeId, mediaUrl }: Props) {
  const recipe = React.useMemo(() => (plan ? buildRenderRecipe(plan, youtubeId) : null), [plan, youtubeId])
  const playerRef = React.useRef<PlayerRef>(null)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [frame, setFrame] = React.useState(0)

  // sync frame from player
  React.useEffect(() => {
    if (!open || !playerRef.current) return
    const interval = setInterval(() => {
      try {
        const f = playerRef.current?.getCurrentFrame?.() ?? 0
        setFrame(f)
      } catch {}
    }, 100)
    return () => clearInterval(interval)
  }, [open, playerRef])

  if (!open || !plan || !recipe) return null

  const durationInFrames = Math.max(1, Math.round(recipe.duration * FPS))
  const compositionWidth = 1080
  const compositionHeight = 1920

  const handlePlayPause = () => {
    if (!playerRef.current) return
    const p = playerRef.current
    if (isPlaying) {
      p.pause()
      setIsPlaying(false)
    } else {
      p.play()
      setIsPlaying(true)
    }
  }

  const handleRestart = () => {
    playerRef.current?.seekTo(0)
    setFrame(0)
  }

  const inputProps = {
    recipe,
    youtubeId,
    mediaUrl: mediaUrl ?? null,
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
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
            <h3 className="text-sm font-semibold">Interactive Remotion Editor</h3>
            <Badge variant="secondary" className="text-[10px]">
              {recipe.title.slice(0, 35)}
            </Badge>
            <span className="text-[10px] text-muted-foreground">· 1080×1920 · 9:16</span>
            {mediaUrl && (
              <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 text-[10px] dark:text-emerald-400">
                <HardDrive className="h-3 w-3" />
                real source · cuts removed
              </Badge>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} className="h-7 text-xs">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="grid gap-0 md:grid-cols-[1fr_320px]">
          {/* player */}
          <div className="relative bg-black p-4">
            <div className="mx-auto" style={{ width: '100%', maxWidth: 'calc(70vh * 9 / 16)' }}>
              <div style={{ position: 'relative', paddingBottom: '177.78%' }}>
                <Player
                  ref={playerRef}
                  component={ClipComposition as any}
                  inputProps={inputProps}
                  durationInFrames={durationInFrames}
                  fps={FPS}
                  compositionWidth={compositionWidth}
                  compositionHeight={compositionHeight}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                  }}
                  controls
                  loop
                  autoPlay={false}
                  clickToPlay={false}
                />
              </div>
            </div>

            {/* controls below */}
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handlePlayPause}
                className="h-8 gap-1.5"
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPlaying ? 'Pause' : 'Play'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRestart}
                className="h-8 gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restart
              </Button>
              <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                {fmtTime(frame / FPS)} / {fmtTime(recipe.duration)}
              </span>
              <span className="text-[10px] text-muted-foreground">frame {frame}/{durationInFrames}</span>
            </div>
          </div>

          {/* side panel: live segments + state */}
          <div className="border-l border-border/60 bg-card/30 p-3 text-xs">
            <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Scissors className="h-3 w-3 text-primary" />
              Segments ({recipe.segments.length})
            </h4>
            <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin">
              {recipe.segments.map((s, i) => {
                const segStartFrame = Math.max(0, Math.round((s.start - recipe.clipStart) * FPS))
                const segEndFrame = Math.min(durationInFrames, Math.round((s.end - recipe.clipStart) * FPS))
                const isActive = frame >= segStartFrame && frame < segEndFrame
                const SEG_COLORS: Record<string, string> = {
                  HOOK: 'bg-rose-500',
                  CONTEXT: 'bg-sky-500',
                  DEVELOPMENT: 'bg-violet-500',
                  EXAMPLE: 'bg-amber-500',
                  CONTRAST: 'bg-orange-500',
                  PAYOFF: 'bg-emerald-500',
                  CTA: 'bg-cyan-500',
                }
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-1.5 rounded p-1.5 transition-colors ${
                      isActive ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${SEG_COLORS[s.type] ?? 'bg-muted'}`} />
                    <span className={`text-[10px] font-bold ${isActive ? 'text-primary' : ''}`}>
                      {s.type}
                    </span>
                    <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground">
                      {fmtTime(s.start - recipe.clipStart)}–{fmtTime(s.end - recipe.clipStart)}
                    </span>
                  </div>
                )
              })}
            </div>

            <h4 className="mb-2 mt-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Type className="h-3 w-3 text-primary" />
              Subtitles ({recipe.subtitles.length})
            </h4>
            <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-thin">
              {recipe.subtitles.map((s, i) => {
                const subStartFrame = Math.max(0, Math.round((s.start - recipe.clipStart) * FPS))
                const subEndFrame = Math.min(durationInFrames, Math.round((s.end - recipe.clipStart) * FPS))
                const isActive = frame >= subStartFrame && frame < subEndFrame
                return (
                  <div
                    key={i}
                    className={`flex items-start gap-1.5 rounded p-1.5 ${isActive ? 'bg-primary/10' : ''}`}
                  >
                    <span className="font-mono text-[9px] tabular-nums text-muted-foreground mt-0.5">
                      {fmtTime(s.start - recipe.clipStart)}
                    </span>
                    <p className={`text-[11px] flex-1 ${isActive ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                      {s.text}
                    </p>
                  </div>
                )
              })}
            </div>

            <h4 className="mb-2 mt-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Camera className="h-3 w-3 text-violet-500" />
              Camera moves ({recipe.cameraKeyframes.length / 2})
            </h4>
            <div className="space-y-1">
              {recipe.cameraKeyframes
                .filter((_, i) => i % 2 === 0)
                .map((kf, i) => {
                  const camStartFrame = Math.round((kf.time - recipe.clipStart) * FPS)
                  const next = recipe.cameraKeyframes[i * 2 + 1]
                  const camEndFrame = next ? Math.round((next.time - recipe.clipStart) * FPS) : camStartFrame
                  const isActive = frame >= camStartFrame && frame < camEndFrame
                  return (
                    <div key={i} className={`flex items-center gap-2 rounded p-1 ${isActive ? 'bg-violet-500/10' : ''}`}>
                      <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
                        {fmtTime(kf.time - recipe.clipStart)}–{next ? fmtTime(next.time - recipe.clipStart) : ''}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-violet-500">
                        {kf.scale.toFixed(2)}→{next?.scale.toFixed(2) ?? kf.scale.toFixed(2)}×
                      </span>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="border-t border-border/60 bg-card/40 p-3">
          <p className="text-[10px] leading-snug text-muted-foreground">
            <Sparkles className="mr-1 inline h-2.5 w-2.5 text-primary" />
            <strong className="text-foreground">Interactive Remotion preview</strong> — the edit plan rendered as React
            components. Subtitles, segment badges, camera zoom, and visual cards are all applied in real-time as you scrub.
            Click play or use the timeline below the player to preview.
          </p>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ---- Remotion Composition ----
// Renders the clip as a 9:16 vertical video with all edit plan effects applied

const ClipComposition: React.FC<{ recipe: any; youtubeId: string; mediaUrl: string | null }> = ({
  recipe,
  youtubeId,
  mediaUrl,
}) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const t = frame / fps // relative time within clip (OUTPUT time)

  // Output→source mapping: without real media the output timeline is the raw
  // clip window (the iframe cannot skip mid-clip cuts); with real media the
  // keep ranges are physically concatenated, so map output time into source time.
  const keepRanges = React.useMemo(
    () => (mediaUrl ? mapKeepRanges(recipe.clipStart, recipe.clipEnd, recipe.cuts ?? []) : null),
    [mediaUrl, recipe.clipStart, recipe.clipEnd, recipe.cuts],
  )
  let absTime = recipe.clipStart + t
  if (keepRanges && keepRanges.length > 0) {
    absTime = sourceTimeAtOutput(keepRanges, t)
  }

  // camera scale at current time
  const scale = scaleAtTime(absTime, recipe.cameraKeyframes ?? [])

  // current segment
  const segment = recipe.segments?.find((s: any) => absTime >= s.start && absTime < s.end) ?? null

  // current subtitle
  const subtitle = recipe.subtitles?.find((s: any) => absTime >= s.start && absTime < s.end) ?? null

  // current visual
  const visual = recipe.visuals?.find((v: any) => absTime >= v.start && absTime < v.end) ?? null

  // generated hook (only first 3s)
  const showHook = t < 3 && recipe.generatedHook

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Real source video with cuts physically removed (keep-range sequences),
          or the YouTube iframe approximation when no local media exists. */}
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          transition: 'transform 0.05s linear',
        }}
      >
        {mediaUrl && keepRanges && keepRanges.length > 0 ? (
          <KeepRangeSequences
            mediaUrl={mediaUrl}
            keepRanges={keepRanges}
            fps={fps}
            durationInFrames={durationInFrames}
          />
        ) : (
          <iframe
            src={`https://www.youtube.com/embed/${youtubeId}?start=${Math.floor(recipe.clipStart)}&end=${Math.ceil(recipe.clipEnd)}&autoplay=0&mute=1&controls=0&modestbranding=1&rel=0&loop=1&playsinline=1`}
            width="100%"
            height="100%"
            style={{
              border: 0,
              pointerEvents: 'none',
              objectFit: 'cover',
            }}
            allow="autoplay; encrypted-media"
          />
        )}
      </div>

      {/* Hook title card */}
      {showHook && <HookCard text={recipe.generatedHook} frame={frame} fps={fps} />}

      {/* Segment badge */}
      {segment && <SegmentBadge type={segment.type} />}

      {/* Visual overlay card */}
      {visual && <VisualCard visual={visual} frame={frame} fps={fps} />}

      {/* Subtitle */}
      {subtitle && <SubtitleOverlay subtitle={subtitle} />}

      {/* Progress bar at bottom */}
      <ProgressBar
        progress={frame / durationInFrames}
        segments={recipe.segments}
        clipStart={recipe.clipStart}
        duration={recipe.duration}
      />
    </AbsoluteFill>
  )
}

/**
 * Physically concatenates the keep ranges on the output timeline — this is the
 * SAME keep_ranges contract the FFmpeg renderer consumes, applied to a live
 * preview. Each range is a <Sequence> whose <Video> is trimmed to the source
 * segment, so play/scrub/loop are cut-accurate.
 */
const KeepRangeSequences: React.FC<{
  mediaUrl: string
  keepRanges: KeepRange[]
  fps: number
  durationInFrames: number
}> = ({ mediaUrl, keepRanges, fps, durationInFrames }) => {
  // pre-compute frame boundaries so consecutive sequences leave no gaps
  const seqs = React.useMemo(() => {
    const list: { from: number; length: number; trimBefore: number; trimAfter: number }[] = []
    let acc = 0
    for (const r of keepRanges) {
      const length = Math.max(1, Math.round((r.srcEnd - r.srcStart) * fps))
      list.push({ from: acc, length, trimBefore: Math.round(r.srcStart * fps), trimAfter: Math.round(r.srcEnd * fps) })
      acc += length
    }
    return list
  }, [keepRanges, fps])
  return (
    <>
      {seqs.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={Math.min(s.length, Math.max(1, durationInFrames - s.from))}>
          <Video
            src={mediaUrl}
            trimBefore={s.trimBefore}
            trimAfter={s.trimAfter}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            pauseWhenBuffering
          />
        </Sequence>
      ))}
    </>
  )
}

const HookCard: React.FC<{ text: string; frame: number; fps: number }> = ({ text, frame, fps }) => {
  const opacity = interpolate(frame, [0, 5, fps * 2.5, fps * 3], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const scale = spring({ frame, fps, config: { damping: 12, stiffness: 120 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity }}>
      <div
        style={{
          background: 'rgba(244, 63, 94, 0.95)',
          color: 'white',
          padding: '40px 32px',
          borderRadius: 24,
          fontSize: 56,
          fontWeight: 900,
          textAlign: 'center',
          maxWidth: 900,
          fontFamily: 'Inter, sans-serif',
          boxShadow: '0 20px 60px rgba(244, 63, 94, 0.5)',
          transform: `scale(${scale})`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  )
}

const SEG_COLORS: Record<string, string> = {
  HOOK: '#f43f5e',
  CONTEXT: '#0ea5e9',
  DEVELOPMENT: '#8b5cf6',
  EXAMPLE: '#f59e0b',
  CONTRAST: '#f97316',
  PAYOFF: '#10b981',
  CTA: '#06b6d4',
}

const SegmentBadge: React.FC<{ type: string }> = ({ type }) => {
  return (
    <AbsoluteFill style={{ padding: 40, alignItems: 'flex-start', justifyContent: 'flex-start' }}>
      <div
        style={{
          background: SEG_COLORS[type] ?? '#6b7280',
          color: 'white',
          padding: '8px 16px',
          borderRadius: 8,
          fontSize: 24,
          fontWeight: 800,
          letterSpacing: 1,
          fontFamily: 'Inter, sans-serif',
          textTransform: 'uppercase',
        }}
      >
        {type}
      </div>
    </AbsoluteFill>
  )
}

const VisualCard: React.FC<{ visual: any; frame: number; fps: number }> = ({ visual, frame, fps }) => {
  // Remotion's interpolate() requires STRICTLY monotonic inputRange — a duplicated
  // keyframe ([..., 30, 30]) throws and the ErrorBoundary blanks the whole preview.
  // Fade in over 10 frames, then hold. A short visual still fades in fully as long
  // as its Sequence is >= 10 frames (plan validation guarantees >= 0.5s segments).
  const fadeIn = Math.min(10, Math.max(1, Math.floor(fps / 3)))
  const opacity = interpolate(frame, [0, fadeIn], [0, 1], {
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  })
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        padding: 100,
        opacity,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
      }}
    >
      <div
        style={{
          background: 'rgba(255, 255, 255, 0.1)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.3)',
          padding: 32,
          borderRadius: 24,
          maxWidth: 800,
          color: 'white',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, color: '#f43f5e' }}>
          {visual.type}
        </div>
        <div style={{ fontSize: 28, fontWeight: 600, marginBottom: 16 }}>{visual.purpose}</div>
        <div style={{ fontSize: 20, fontStyle: 'italic', opacity: 0.85 }}>{visual.prompt}</div>
      </div>
    </AbsoluteFill>
  )
}

const SubtitleOverlay: React.FC<{ subtitle: any }> = ({ subtitle }) => {
  const text = subtitle.text
  const emphasisWords: string[] = subtitle.emphasis_words ?? []
  const emphasisType: string = subtitle.emphasis_type ?? 'bold'

  // Render text with emphasis words highlighted
  const parts: React.ReactNode[] = []
  let remaining = text
  let cursor = 0
  const lower = text.toLowerCase()
  const matches: { start: number; end: number }[] = []
  emphasisWords.forEach((w) => {
    const wl = w.toLowerCase()
    let idx = lower.indexOf(wl)
    while (idx !== -1) {
      matches.push({ start: idx, end: idx + w.length })
      idx = lower.indexOf(wl, idx + 1)
    }
  })
  matches.sort((a, b) => a.start - b.start)
  let pos = 0
  const seen = new Set<number>()
  matches.forEach((m, i) => {
    if (m.start < pos || seen.has(m.start)) return
    parts.push(text.slice(pos, m.start))
    let emphStyle: React.CSSProperties = { color: '#fbbf24', fontWeight: 800 }
    if (emphasisType === 'uppercase') emphStyle = { ...emphStyle, textTransform: 'uppercase', fontSize: 56 }
    else if (emphasisType === 'color') emphStyle = { color: '#f43f5e', fontWeight: 800 }
    else if (emphasisType === 'pop') emphStyle = { color: '#fde047', fontSize: 60, fontWeight: 900 }
    else if (emphasisType === 'background') emphStyle = { backgroundColor: 'rgba(244, 63, 94, 0.9)', color: 'white', fontWeight: 800, padding: '2px 6px', borderRadius: 4 }
    parts.push(
      <span key={i} style={emphStyle}>
        {text.slice(m.start, m.end)}
      </span>,
    )
    pos = m.end
    seen.add(m.start)
  })
  if (pos < text.length) parts.push(text.slice(pos))

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 200 }}>
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.85)',
          padding: '24px 40px',
          borderRadius: 16,
          maxWidth: 900,
          textAlign: 'center',
          color: 'white',
          fontSize: 48,
          fontWeight: 700,
          fontFamily: 'Inter, sans-serif',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        {parts}
      </div>
    </AbsoluteFill>
  )
}

const ProgressBar: React.FC<{ progress: number; segments: any[]; clipStart: number; duration: number }> = ({
  progress,
  segments,
  clipStart,
  duration,
}) => {
  return (
    <AbsoluteFill style={{ alignItems: 'flex-end', justifyContent: 'flex-end', padding: 20 }}>
      <div
        style={{
          width: '90%',
          height: 6,
          background: 'rgba(255,255,255,0.2)',
          borderRadius: 999,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* segment markers */}
        {segments.map((s, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${((s.start - clipStart) / duration) * 100}%`,
              width: 2,
              height: '100%',
              background: SEG_COLORS[s.type] ?? '#888',
            }}
          />
        ))}
        {/* progress fill */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: `${progress * 100}%`,
            background: '#f43f5e',
            borderRadius: 999,
          }}
        />
      </div>
    </AbsoluteFill>
  )
}

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Play, User, Clock, ExternalLink, Youtube, AlertCircle, FileVideo } from 'lucide-react'
import { fmtDuration, type YouTubeMeta } from '@/lib/youtube'

interface Props {
  meta: YouTubeMeta
  playStart?: number | null
}

export function VideoPreview({ meta, playStart }: Props) {
  const [iframeKey, setIframeKey] = React.useState(0)
  const [embedUrl, setEmbedUrl] = React.useState(meta.embedUrl)

  React.useEffect(() => {
    // Seek to clip start when a clip is selected
    if (playStart != null && playStart >= 0) {
      setEmbedUrl(`${meta.embedUrl}?start=${Math.floor(playStart)}&rel=0&modestbranding=1`)
      setIframeKey((k) => k + 1)
    } else {
      setEmbedUrl(`${meta.embedUrl}?rel=0&modestbranding=1`)
      setIframeKey((k) => k + 1)
    }
  }, [playStart, meta.embedUrl])

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-xl"
    >
      {/* Player — uploads have no YouTube embed; show a stylized placeholder */}
      {meta.embedUrl ? (
        <div className="relative aspect-video w-full bg-black">
          <iframe
            key={iframeKey}
            src={embedUrl}
            title={meta.title}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-violet-950/60 via-card to-rose-950/40">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-violet-500/15 text-violet-400 ring-1 ring-violet-500/30">
            <FileVideo className="h-7 w-7" />
          </div>
          <p className="text-sm font-semibold text-foreground">Local media — analyzed via ASR</p>
          <p className="text-xs text-muted-foreground">
            {meta.duration != null ? `${Math.floor(meta.duration / 60)}m ${Math.round(meta.duration % 60)}s` : ''} · duration measured by ffprobe · transcript by Whisper
          </p>
        </div>
      )}

      {/* Meta */}
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Youtube className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
              {meta.title}
            </h3>
            {meta.author && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="h-3 w-3" />
                {meta.author}
              </div>
            )}
          </div>
          <a
            href={meta.url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Open on YouTube"
            onClick={(e) => {
              if (!meta.url.startsWith('http')) e.preventDefault()
            }}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={
              meta.durationSource === 'unavailable'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            }
          >
            <Clock className="h-3 w-3" />
            {meta.duration != null ? fmtDuration(meta.duration) : 'duration unavailable'}
          </Badge>
          {meta.durationSource && (
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground"
              title={
                meta.durationSource === 'yt-dlp'
                  ? 'Exact duration resolved via yt-dlp'
                  : meta.durationSource === 'innertube'
                    ? 'Duration resolved via YouTube player API'
                    : meta.durationSource === 'user-provided'
                      ? 'Duration entered manually (server could not fetch it)'
                      : 'Server could not fetch duration — enter it manually in Advanced options'
              }
            >
              source: {meta.durationSource}
            </Badge>
          )}
          <Badge>
            <Play className="h-3 w-3" />
            {meta.youtubeId}
          </Badge>
          <Badge>{meta.provider}</Badge>
        </div>

        {meta.requiresManualDuration && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              YouTube blocked the server from reading this video&apos;s real duration (bot protection). Enter the actual duration under <strong>Advanced → Duration</strong> — ClipForge will not analyze on a guessed value.
            </span>
          </div>
        )}

        {playStart != null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            Previewing clip starting at {Math.floor(playStart)}s — seeked via YouTube embed
          </motion.div>
        )}
      </div>
    </motion.div>
  )
}

function Badge({
  children,
  className,
  variant,
  title,
}: {
  children: React.ReactNode
  className?: string
  variant?: string
  title?: string
}) {
  const base =
    variant === 'outline'
      ? 'border-border/60 bg-transparent'
      : 'border-border/60 bg-muted/40'
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground ${base} ${className ?? ''}`}
    >
      {children}
    </span>
  )
}

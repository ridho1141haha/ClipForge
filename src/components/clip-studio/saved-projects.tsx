'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Trash2,
  Eye,
  Clock,
  Scissors,
  Film,
  Loader2,
  RefreshCw,
  Search,
  Film as FilmIcon,
  Sparkles,
  TrendingUp,
  AlertTriangle,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { fmtDuration, type Project } from '@/lib/youtube'

interface Props {
  projects: Project[]
  loading: boolean
  onSelect: (p: Project) => void
  onDelete: (id: string) => void
  onRefresh: () => void
}

export function SavedProjects({ projects, loading, onSelect, onDelete, onRefresh }: Props) {
  const [query, setQuery] = React.useState('')
  const [sortBy, setSortBy] = React.useState<'recent' | 'clips' | 'duration'>('recent')

  const filtered = React.useMemo(() => {
    let r = projects
    if (query.trim()) {
      const q = query.toLowerCase()
      r = r.filter(
        (p) =>
          p.title.toLowerCase().includes(q) || (p.author ?? '').toLowerCase().includes(q),
      )
    }
    const sorted = [...r]
    if (sortBy === 'clips') sorted.sort((a, b) => b.clipCount - a.clipCount)
    else if (sortBy === 'duration')
      sorted.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    else sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    return sorted
  }, [projects, query, sortBy])

  const totalClips = projects.reduce((acc, p) => acc + p.clipCount, 0)
  const totalDuration = projects.reduce((acc, p) => acc + (p.duration ?? 0), 0)
  const analyzedCount = projects.filter((p) => p.status === 'analyzed').length

  if (loading) {
    return (
      <div>
        <div className="mb-4 flex flex-wrap gap-3">
          <div className="shimmer h-8 w-24 rounded-lg" />
          <div className="shimmer h-8 w-24 rounded-lg" />
          <div className="shimmer h-8 w-24 rounded-lg" />
          <div className="shimmer h-9 w-48 rounded-lg" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-44 overflow-hidden rounded-xl border border-border/60 bg-card/40"
            >
              <div className="shimmer h-24 w-full" />
              <div className="space-y-2 p-3">
                <div className="shimmer h-4 w-3/4 rounded" />
                <div className="shimmer h-3 w-1/2 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="relative overflow-hidden rounded-xl border border-dashed border-border bg-card/30 py-16 text-center"
      >
        <div className="pointer-events-none absolute inset-0 bg-grid bg-grid-fade opacity-30" />
        <div className="relative">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
            <FilmIcon className="h-8 w-8" />
          </div>
          <p className="text-base font-semibold text-foreground">Your library is empty</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Paste a YouTube link above, analyze it, and save the project here. Your library
            keeps every project with its AI clips, scores, and edit plans.
          </p>
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            Saved projects persist in your browser database
          </div>
        </div>
      </motion.div>
    )
  }

  return (
    <div>
      {/* summary header */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5">
          <FilmIcon className="h-3.5 w-3.5 text-primary" />
          <span className="text-sm font-semibold tabular-nums">{projects.length}</span>
          <span className="text-xs text-muted-foreground">project{projects.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5">
          <Scissors className="h-3.5 w-3.5 text-violet-500" />
          <span className="text-sm font-semibold tabular-nums">{totalClips}</span>
          <span className="text-xs text-muted-foreground">clips</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5">
          <Clock className="h-3.5 w-3.5 text-sky-500" />
          <span className="text-sm font-semibold tabular-nums">{fmtDuration(totalDuration)}</span>
          <span className="text-xs text-muted-foreground">total</span>
        </div>
        {analyzedCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5">
            <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-sm font-semibold tabular-nums">{analyzedCount}</span>
            <span className="text-xs text-muted-foreground">analyzed</span>
          </div>
        )}

        {/* search + sort */}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or channel…"
              className="h-9 w-48 pl-8 pr-8 text-xs sm:w-56"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/40 p-0.5">
            {(['recent', 'clips', 'duration'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  sortBy === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {s === 'recent' ? 'Recent' : s === 'clips' ? 'Most clips' : 'Longest'}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            className="h-9 w-9 px-0"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/30 py-10 text-center">
          <Search className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No projects match “{query}”.
          </p>
          <button
            onClick={() => setQuery('')}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Clear search
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p, idx) => (
            <motion.div
              key={p.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: Math.min(idx * 0.05, 0.3) }}
              className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-all hover:border-primary/40 hover:shadow-xl"
            >
              {/* thumbnail */}
              <div className="relative aspect-video w-full overflow-hidden bg-muted">
                {p.thumbnail ? (
                  <img
                    src={p.thumbnail}
                    alt={p.title}
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-muted-foreground">
                    <Film className="h-8 w-8" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                  <Badge className="border-0 bg-black/60 text-white hover:bg-black/60">
                    <Clock className="mr-1 h-2.5 w-2.5" />
                    {p.duration ? fmtDuration(p.duration) : '—'}
                  </Badge>
                  <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                    {p.status}
                  </span>
                </div>
                {/* hover overlay */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg">
                    <Eye className="h-5 w-5" />
                  </div>
                </div>
              </div>

              {/* body */}
              <div className="space-y-2 p-3">
                <h4 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
                  {p.title}
                </h4>
                {p.author && (
                  <p className="text-xs text-muted-foreground">{p.author}</p>
                )}
                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Scissors className="h-3 w-3 text-violet-500" />
                    {p.clipCount} clip{p.clipCount === 1 ? '' : 's'}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onSelect(p)}
                      className="h-7 gap-1 px-2 text-xs"
                    >
                      <Eye className="h-3 w-3" />
                      Open
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete(p.id)}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground/70">
                  Updated {timeAgo(p.updatedAt)}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

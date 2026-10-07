'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useToast } from '@/hooks/use-toast'
import { useKeyboardShortcuts } from '@/hooks/use-clip-shortcuts'
import {
  Sparkles,
  Wand2,
  Scissors,
  Brain,
  TrendingUp,
  Download,
  Save,
  ArrowRight,
  Zap,
  Clock,
  Tags,
  Quote,
  Trash2,
  RefreshCw,
  Film,
  CheckCircle2,
  RotateCw,
} from 'lucide-react'

import { Header } from '@/components/clip-studio/header'
import { Footer } from '@/components/clip-studio/footer'
import { UrlInput, type AnalyzeParams } from '@/components/clip-studio/url-input'
import { VideoPreview } from '@/components/clip-studio/video-preview'
import { Timeline } from '@/components/clip-studio/timeline'
import { ClipCard } from '@/components/clip-studio/clip-card'
import { ClipEditor } from '@/components/clip-studio/clip-editor'
import { ExportDialog } from '@/components/clip-studio/export-dialog'
import { AnalyzingState } from '@/components/clip-studio/analyzing-state'
import { SavedProjects } from '@/components/clip-studio/saved-projects'
import { BulkActionBar } from '@/components/clip-studio/bulk-action-bar'
import {
  SortFilterBar,
  type SortKey,
  type FilterKey,
} from '@/components/clip-studio/sort-filter-bar'
import { ReanalyzePanel } from '@/components/clip-studio/reanalyze-panel'
import { SourceStatusPanel, TranscriptViewer } from '@/components/clip-studio/source-status'
import { ShortcutsHint } from '@/components/clip-studio/shortcuts-hint'
import { EditPlanView } from '@/components/clip-studio/edit-plan-view'
import { AutoEditPlayer } from '@/components/clip-studio/auto-edit-player'
import { HeroStats } from '@/components/clip-studio/hero-stats'
import { LivePreviewCard } from '@/components/clip-studio/live-preview-card'
import { FeaturesGrid } from '@/components/clip-studio/features-grid'
import { Tutorial } from '@/components/clip-studio/tutorial'
import { UploadRender } from '@/components/clip-studio/upload-render'
import { RemotionPlayer } from '@/components/clip-studio/remotion-player'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  fmtTime,
  fmtDuration,
  sortClips,
  filterClips,
  type YouTubeMeta,
  type SuggestedClip,
  type AnalyzeResult,
  type Project,
} from '@/lib/youtube'
import type { EditPlan } from '@/lib/editplan'
import { safeJson } from '@/lib/editplan'

type Phase = 'idle' | 'fetching' | 'analyzing' | 'done'

export default function Home() {
  const { toast } = useToast()

  // core state
  const [phase, setPhase] = React.useState<Phase>('idle')
  const [meta, setMeta] = React.useState<YouTubeMeta | null>(null)
  const [analyzeResult, setAnalyzeResult] = React.useState<AnalyzeResult | null>(null)
  const [clips, setClips] = React.useState<SuggestedClip[]>([])
  const [selectedIdx, setSelectedIdx] = React.useState<number | null>(null)
  const [multiSelected, setMultiSelected] = React.useState<Set<number>>(new Set())
  const [playStart, setPlayStart] = React.useState<number | null>(null)
  const [projectId, setProjectId] = React.useState<string | null>(null)
  // server-side source media state for the CURRENT project (render-without-upload)
  const [projectMedia, setProjectMedia] = React.useState<{ state?: string | null; size?: number | null; error?: string | null } | null>(null)
  const [sourceTranscript, setSourceTranscript] = React.useState<string | null>(null)
  const [sourceWords, setSourceWords] = React.useState<{ word: string; start: number; end: number }[] | null>(null)
  const [wordTiming, setWordTiming] = React.useState<'measured' | 'estimated' | null>(null)
  const [transcriptOpen, setTranscriptOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [currentPlatform, setCurrentPlatform] = React.useState('shorts')
  const [currentStyle, setCurrentStyle] = React.useState('podcast')
  const [currentTargetDuration, setCurrentTargetDuration] = React.useState(45)
  const [currentLanguage, setCurrentLanguage] = React.useState('auto')
  const [reanalyzeOpen, setReanalyzeOpen] = React.useState(false)
  const [reanalyzing, setReanalyzing] = React.useState(false)

  // async prepare-job state (REAL stages: metadata → captions → project)
  const [prepareStage, setPrepareStage] = React.useState<string | null>(null)
  const [prepareProgress, setPrepareProgress] = React.useState<number | null>(null)
  const [prepareError, setPrepareError] = React.useState<string | null>(null)
  const prepareJobRef = React.useRef<string | null>(null)
  const prepareJobUrlRef = React.useRef<string | null>(null)
  const lastAnalyzeParamsRef = React.useRef<AnalyzeParams | null>(null)

  // sort & filter
  const [sort, setSort] = React.useState<SortKey>('default')
  const [filter, setFilter] = React.useState<FilterKey>('all')

  // dialog state
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editIdx, setEditIdx] = React.useState<number | null>(null)
  const [exportOpen, setExportOpen] = React.useState(false)

  // edit plan dialog state
  const [planViewOpen, setPlanViewOpen] = React.useState(false)
  const [planClipIdx, setPlanClipIdx] = React.useState<number | null>(null)
  const [planLoading, setPlanLoading] = React.useState(false)
  const [currentPlan, setCurrentPlan] = React.useState<EditPlan | null>(null)

  // auto-edit player state
  const [autoEditOpen, setAutoEditOpen] = React.useState(false)

  // remotion editor state
  const [remotionOpen, setRemotionOpen] = React.useState(false)

  // library tab: 'library' or 'render'
  const [libraryTab, setLibraryTab] = React.useState<'library' | 'render'>('library')

  // library state
  const [savedProjects, setSavedProjects] = React.useState<Project[]>([])
  const [loadingProjects, setLoadingProjects] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const studioRef = React.useRef<HTMLDivElement>(null)

  // ---- derived: filtered + sorted clips for display ----
  const displayClips = React.useMemo(() => {
    const filtered = filterClips(clips, filter)
    return sortClips(filtered, sort)
  }, [clips, filter, sort])

  // map from display index -> original index
  const displayToOriginal = React.useMemo(() => {
    const map: Record<number, number> = {}
    displayClips.forEach((c) => {
      const orig = clips.findIndex((oc) => oc === c)
      map[displayClips.indexOf(c)] = orig
    })
    return map
  }, [displayClips, clips])

  const originalToDisplay = React.useMemo(() => {
    const map: Record<number, number> = {}
    clips.forEach((c, i) => {
      const d = displayClips.indexOf(c)
      if (d >= 0) map[i] = d
    })
    return map
  }, [clips, displayClips])

  // ---- fetch saved projects on mount ----
  const refreshProjects = React.useCallback(async () => {
    setLoadingProjects(true)
    try {
      const res = await fetch('/api/projects')
      const data = await res.json()
      setSavedProjects(data.projects ?? [])
    } catch {
      /* ignore */
    } finally {
      setLoadingProjects(false)
    }
  }, [])

  React.useEffect(() => {
    refreshProjects()
  }, [refreshProjects])

  // ---- analyze flow ----
  /**
   * Async source preparation via the job pipeline: resolves REAL metadata +
   * REAL captions (with word timestamps) into an owned Project, with live
   * stage/progress surfaced to the UI. Reuses a failed job via /retry.
   * Returns the job result, or null on failure (jobId kept in ref for retry).
   */
  const prepareSource = async (url: string, language: string, manualDuration?: number): Promise<Record<string, unknown> | null> => {
    setPrepareStage('Queued…')
    setPrepareProgress(1)
    try {
      // reuse the failed job (via /retry) when it belongs to the same URL;
      // a different URL always starts a fresh job
      const existingJob = prepareJobUrlRef.current === url ? prepareJobRef.current : null
      const res = await fetch(existingJob ? `/api/jobs/${existingJob}/retry` : '/api/source/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, language, manualDuration }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Prepare failed')
      const jobId: string = data.jobId
      prepareJobRef.current = jobId
      prepareJobUrlRef.current = url
      // poll (max ~22 min — the media-download stage for long videos is slow,
      // but a poll is cheap; stage text keeps the user informed)
      for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        let job: Record<string, unknown>
        try {
          const jr = await fetch(`/api/jobs/${jobId}`)
          const jd = await jr.json()
          if (!jr.ok) throw new Error(jd.error ?? 'Job lost')
          job = jd.job ?? {}
        } catch {
          continue // transient poll error — keep polling
        }
        setPrepareStage((job.stage as string) ?? '')
        setPrepareProgress(typeof job.progress === 'number' ? job.progress : null)
        if (job.status === 'COMPLETED') {
          // job consumed — next video starts a fresh job
          prepareJobRef.current = null
          prepareJobUrlRef.current = null
          return (job.result ?? {}) as Record<string, unknown>
        }
        if (job.status === 'FAILED') {
          throw new Error((job.errorMessage as string) ?? 'Source preparation failed')
        }
      }
      throw new Error('Source preparation timed out')
    } finally {
      setPrepareStage(null)
      setPrepareProgress(null)
    }
  }

  const analyze = React.useCallback(
    async (
      url: string,
      platform: string,
      clipCount: number,
      style: string,
      targetDuration: number,
      language: string,
      transcript?: string,
      manualDuration?: number,
      isReanalyze = false,
      words?: { word: string; start: number; end: number }[],
      preResolvedMeta?: Partial<YouTubeMeta> & { title: string },
      preSetProjectId?: string,
      skipPrepare = false,
    ) => {
      setError(null)
      if (preSetProjectId) setProjectId(preSetProjectId)
      if (!isReanalyze) {
        setPhase('fetching')
        setMeta(null)
        setAnalyzeResult(null)
        setClips([])
        setProjectId(null)
        setProjectMedia(null)
        setSelectedIdx(null)
        setMultiSelected(new Set())
        setPlayStart(null)
        setPrepareError(null)
        setTimeout(
          () => studioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          80,
        )
      } else {
        setReanalyzing(true)
      }

      // 1. fetch metadata (only if not already loaded)
      let localMeta: YouTubeMeta | null = meta
      let prepProjectId: string | null = null
      if (preResolvedMeta) {
        // e.g. upload/ASR flow — duration + title measured locally, no YouTube call
        localMeta = {
          youtubeId: preResolvedMeta.youtubeId ?? 'upload',
          url: preResolvedMeta.url ?? 'upload://local',
          title: preResolvedMeta.title,
          author: preResolvedMeta.author ?? null,
          thumbnail: preResolvedMeta.thumbnail ?? '',
          provider: 'Local upload',
          duration: preResolvedMeta.duration ?? null,
          durationSource: preResolvedMeta.durationSource ?? 'ffprobe',
          requiresManualDuration: false,
          description: null,
          embedUrl: '',
          embedUrlAutoplay: '',
        }
        setMeta(localMeta)
      } else if (!isReanalyze && !skipPrepare && !preSetProjectId && !projectId && !transcript?.trim() && !words?.length) {
        // 0. ASYNC PREPARE (job pipeline): resolve REAL metadata + REAL captions
        // (word timestamps) into an owned project, with live stage/progress UI.
        // The analyze call then grounds from the prepared project.
        try {
          const prep = await prepareSource(url, language, manualDuration)
          if (prep) {
            prepProjectId = (prep.projectId as string) ?? null
            if (prepProjectId) setProjectId(prepProjectId)
            const ytId = (prep.youtubeId as string) ?? ''
            localMeta = {
              youtubeId: ytId,
              url,
              title: (prep.title as string) ?? 'YouTube video',
              author: (prep.author as string) ?? null,
              thumbnail: (prep.thumbnail as string) ?? '',
              provider: 'YouTube',
              duration: (prep.duration as number) ?? null,
              durationSource: (prep.durationSource as string) ?? 'unavailable',
              requiresManualDuration: !prep.duration,
              description: null,
              embedUrl: ytId ? `https://www.youtube.com/embed/${ytId}` : '',
              embedUrlAutoplay: ytId ? `https://www.youtube.com/embed/${ytId}?autoplay=1` : '',
            }
            setMeta(localMeta)
            // surface the downloaded source media state (render-without-upload)
            const lm = prep.localMedia as { state?: string; sizeBytes?: number; error?: string } | undefined
            setProjectMedia(lm ? { state: lm.state ?? null, size: lm.sizeBytes ?? null, error: lm.error ?? null } : null)
            const warns = (prep.warnings as string[] | undefined) ?? []
            for (const w of warns.slice(0, 2)) {
              toast({ title: 'Source preparation note', description: w })
            }
          }
        } catch (e: any) {
          setPrepareError(e.message ?? 'Source preparation failed')
          setPhase('fetching') // keep the retry UI visible
          toast({
            title: 'Source preparation failed',
            description: 'You can retry — YouTube blocking is often temporary.',
          })
          return
        }
      } else if (!isReanalyze || !localMeta) {
        try {
          const res = await fetch('/api/youtube/meta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? 'Failed to fetch metadata')
          localMeta = data as YouTubeMeta
          setMeta(localMeta)
        } catch (e: any) {
          setError(e.message ?? 'Failed to fetch video metadata')
          setPhase('idle')
          setReanalyzing(false)
          toast({
            title: 'Could not load video',
            description: e.message,
            variant: 'destructive',
          })
          return
        }
      }

      if (!localMeta) {
        // defensive: none of the resolution paths produced metadata
        setError('Could not resolve video metadata — please try again.')
        setPhase('idle')
        setReanalyzing(false)
        return
      }

      // 2. analyze clips
      if (!isReanalyze) setPhase('analyzing')
      // REAL duration required: either from metadata resolver or manual input.
      // ClipForge never guesses a duration.
      const effDuration = manualDuration && manualDuration > 0 ? manualDuration : localMeta.duration
      if (!effDuration || effDuration <= 0) {
        setError('Real video duration is unavailable (YouTube is blocking metadata from this server). Enter the duration manually in Advanced options, upload the media for ASR, then analyze again.')
        setPhase('idle')
        setReanalyzing(false)
        toast({
          title: 'Duration required',
          description: 'Open the video, check its length and enter it manually — ClipForge does not guess durations.',
          variant: 'destructive',
        })
        return
      }
      // persist the manual duration into the session meta so plan/export flows use it too
      if (localMeta.duration == null && manualDuration && manualDuration > 0) {
        localMeta = {
          ...localMeta,
          duration: manualDuration,
          durationSource: 'user-provided',
          requiresManualDuration: false,
        }
        setMeta(localMeta)
      }
      try {
        const effProjectId = preSetProjectId ?? prepProjectId ?? projectId
        const res = await fetch('/api/clips/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: effProjectId ?? undefined,
            url: localMeta.url,
            title: localMeta.title,
            author: localMeta.author,
            duration: effDuration,
            durationSource: manualDuration && manualDuration > 0 && localMeta.duration == null ? 'user-provided' : localMeta.durationSource ?? 'unknown',
            transcript,
            // omit transcriptSource when we have nothing local — the prepared project's
            // source (youtube-captions) must not be masked by a body 'none'
            ...(words ? { transcriptSource: 'asr' as const } : transcript ? { transcriptSource: 'manual' as const } : {}),
            words,
            platform,
            style,
            targetDuration,
            clipCount,
            language,
            save: true,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'AI analysis failed')
        const result = data as AnalyzeResult
        setAnalyzeResult(result)
        setWordTiming(result.wordTiming ?? null)
        setCurrentPlatform(platform)
        setCurrentStyle(style)
        setCurrentTargetDuration(targetDuration)
        setCurrentLanguage(language)
        // map candidates (new: start/end/spokenHook/scores) or clips (legacy) to SuggestedClip
        const source = (result.candidates ?? result.clips ?? []) as any[]
        const newClips: SuggestedClip[] = source.map((c, i) => ({
          id: c.id ?? `local-${i}`,
          title: c.title ?? '',
          summary: c.summary ?? c.reason ?? '',
          startTime: c.startTime ?? c.start ?? 0,
          endTime: c.endTime ?? c.end ?? 0,
          score: c.score ?? c.scores?.total ?? 0,
          tags: c.tags ?? [],
          hookText: c.spokenHook ?? c.hook ?? '',
          spokenHook: c.spokenHook ?? '',
          hookVerified: Boolean(c.hookVerified),
          status: 'suggested',
          order: i,
          platform,
          style,
          targetDuration,
          scores: c.scores,
          contextRisk: c.context_risk ?? c.contextRisk ?? false,
          contextStatus: c.contextStatus ?? (c.context_risk ? 'RISK' : 'UNKNOWN'),
          recommendation: c.recommendation,
          reason: c.reason,
          clipTranscript: c.transcriptExcerpt ?? c.clipTranscript ?? undefined,
          clipWords: c.clipWords ?? (words ? words.filter((w) => w.end > (c.start ?? 0) && w.start < (c.end ?? 0)) : undefined),
          hasPlan: false,
        }))
        setClips(newClips)
        setSelectedIdx(null)
        setMultiSelected(new Set())
        setPlayStart(null)
        setPhase('done')
        const postCount = newClips.filter((c) => c.recommendation === 'POST').length
        const autoGround = (result as { autoGrounding?: string })?.autoGrounding
        toast({
          title: `${newClips.length} clip candidates ready`,
          description: autoGround
            ? `${autoGround} · ${postCount} recommended to POST`
            : `${postCount} recommended to POST · ${newClips.length - postCount} to skip`,
        })
      } catch (e: any) {
        setError(e.message ?? 'AI analysis failed')
        if (!isReanalyze) setPhase('idle')
        toast({
          title: 'AI analysis failed',
          description: e.message,
          variant: 'destructive',
        })
      } finally {
        setReanalyzing(false)
      }
    },
    [meta, projectId, toast],
  )

  const handleAnalyze = React.useCallback(
    (params: AnalyzeParams) => {
      lastAnalyzeParamsRef.current = params
      setSourceTranscript(params.transcript ?? null)
      setSourceWords(params.words ?? null)
      return analyze(
        params.url,
        params.platform,
        params.clipCount,
        params.style,
        params.targetDuration,
        params.language,
        params.transcript,
        params.manualDuration,
        false,
        params.words,
        params.preResolvedMeta,
        params.projectId,
        params.skipPrepare,
      )
    },
    [analyze],
  )

  const handleReanalyze = React.useCallback(
    (platform: string, style: string, targetDuration: number, count: number) => {
      if (!meta) return
      setReanalyzeOpen(false)
      analyze(meta.url, platform, count, style, targetDuration, currentLanguage, undefined, undefined, true)
    },
    [meta, analyze],
  )

  // prepare-job retry: re-run the SAME analyze params (job reuse happens server-side)
  const handleRetryPrepare = React.useCallback(() => {
    const params = lastAnalyzeParamsRef.current
    if (params) {
      void handleAnalyze(params)
    }
  }, [handleAnalyze])
  // fallback: analyze without a prepared transcript (old synchronous path)
  const handleSkipPrepare = React.useCallback(() => {
    const params = lastAnalyzeParamsRef.current
    if (params) {
      prepareJobRef.current = null
      prepareJobUrlRef.current = null
      void handleAnalyze({ ...params, transcript: params.transcript ?? '' , skipPrepare: true })
    }
  }, [handleAnalyze])

  // ---- clip actions ----
  const setClipStatus = (idx: number, status: 'approved' | 'rejected' | 'suggested') => {
    setClips((cs) => cs.map((c, i) => (i === idx ? { ...c, status } : c)))
  }

  const approveClip = (idx: number) => {
    setClipStatus(idx, 'approved')
    toast({ title: 'Clip approved', description: clips[idx].title.slice(0, 60) })
  }
  const rejectClip = (idx: number) => {
    setClipStatus(idx, 'rejected')
    toast({ title: 'Clip rejected', description: clips[idx].title.slice(0, 60) })
  }
  const resetClip = (idx: number) => {
    setClipStatus(idx, 'suggested')
    toast({ title: 'Clip reset', description: clips[idx].title.slice(0, 60) })
  }

  // ---- multi-select ----
  const toggleMultiSelect = (idx: number, e: React.MouseEvent) => {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    setMultiSelected((prev) => {
      const next = new Set(prev)
      if (additive) {
        if (next.has(idx)) next.delete(idx)
        else next.add(idx)
      } else {
        next.clear()
        next.add(idx)
      }
      return next
    })
    setSelectedIdx(idx)
  }

  const selectAll = () => {
    setMultiSelected(new Set(clips.map((_, i) => i)))
    toast({ title: `Selected all ${clips.length} clips` })
  }
  const clearSelection = () => {
    setMultiSelected(new Set())
    setSelectedIdx(null)
  }

  const approveSelected = () => {
    const ids = Array.from(multiSelected)
    setClips((cs) =>
      cs.map((c, i) => (multiSelected.has(i) ? { ...c, status: 'approved' } : c)),
    )
    toast({ title: `Approved ${ids.length} clips` })
    setMultiSelected(new Set())
  }
  const rejectSelected = () => {
    const ids = Array.from(multiSelected)
    setClips((cs) =>
      cs.map((c, i) => (multiSelected.has(i) ? { ...c, status: 'rejected' } : c)),
    )
    toast({ title: `Rejected ${ids.length} clips` })
    setMultiSelected(new Set())
  }
  const resetSelected = () => {
    setClips((cs) =>
      cs.map((c, i) =>
        multiSelected.has(i) ? { ...c, status: 'suggested' } : c,
      ),
    )
    toast({ title: `Reset ${multiSelected.size} clips` })
    setMultiSelected(new Set())
  }
  const deleteSelected = () => {
    const ids = Array.from(multiSelected)
    setClips((cs) => cs.filter((_, i) => !multiSelected.has(i)))
    setMultiSelected(new Set())
    setSelectedIdx(null)
    toast({ title: `Deleted ${ids.length} clips` })
  }
  const duplicateSelected = () => {
    const sorted = Array.from(multiSelected).sort((a, b) => a - b)
    setClips((cs) => {
      const additions: SuggestedClip[] = []
      sorted.forEach((i) => {
        const c = cs[i]
        if (!c) return
        additions.push({
          ...c,
          id: `local-${Date.now()}-${i}`,
          title: `${c.title} (copy)`,
          status: 'suggested',
          order: (c.order ?? 0) + 0.5,
        })
      })
      return [...cs, ...additions]
    })
    setMultiSelected(new Set())
    toast({ title: `Duplicated ${sorted.length} clips` })
  }
  const splitSelected = () => {
    const sorted = Array.from(multiSelected).sort((a, b) => a - b)
    setClips((cs) => {
      const additions: SuggestedClip[] = []
      const updates: SuggestedClip[] = []
      sorted.forEach((i) => {
        const c = cs[i]
        if (!c) return
        const mid = Math.round((c.startTime + c.endTime) / 2)
        updates.push({ ...c, endTime: mid, title: `${c.title} (part 1)` })
        additions.push({
          ...c,
          id: `local-${Date.now()}-${i}`,
          startTime: mid,
          title: `${c.title} (part 2)`,
          status: 'suggested',
          order: (c.order ?? 0) + 0.3,
        })
      })
      let result = cs.map((c, i) => {
        const u = updates.find((x) => x.id === c.id)
        return u ?? c
      })
      return [...result, ...additions]
    })
    setMultiSelected(new Set())
    toast({ title: `Split ${sorted.length} clips into 2` })
  }

  const approveAll = () => {
    setClips((cs) => cs.map((c) => ({ ...c, status: 'approved' })))
    toast({ title: `Approved all ${clips.length} clips` })
  }

  // ---- single clip ops ----
  const openEditor = (idx: number) => {
    setEditIdx(idx)
    setEditorOpen(true)
  }
  const saveClipFromEditor = (updated: SuggestedClip) => {
    if (editIdx == null) return
    setClips((cs) =>
      cs.map((c, i) =>
        i === editIdx
          ? { ...updated, status: c.status === 'suggested' ? 'edited' : c.status }
          : c,
      ),
    )
    toast({ title: 'Clip updated' })
  }
  const playClip = (idx: number) => {
    setSelectedIdx(idx)
    setPlayStart(clips[idx].startTime)
    toast({
      title: 'Previewing clip',
      description: `Seeking to ${fmtTime(clips[idx].startTime)}`,
    })
  }
  const duplicateClip = (idx: number) => {
    const c = clips[idx]
    if (!c) return
    const dup: SuggestedClip = {
      ...c,
      id: `local-${Date.now()}`,
      title: `${c.title} (copy)`,
      status: 'suggested',
      order: (c.order ?? idx) + 0.5,
    }
    setClips((cs) => {
      const copy = [...cs]
      copy.splice(idx + 1, 0, dup)
      return copy
    })
    toast({ title: 'Clip duplicated' })
  }
  const splitClip = (idx: number) => {
    const c = clips[idx]
    if (!c) return
    const mid = Math.round((c.startTime + c.endTime) / 2)
    setClips((cs) => {
      const copy = [...cs]
      copy[idx] = { ...c, endTime: mid, title: `${c.title} (part 1)` }
      copy.splice(idx + 1, 0, {
        ...c,
        id: `local-${Date.now()}`,
        startTime: mid,
        title: `${c.title} (part 2)`,
        status: 'suggested',
        order: (c.order ?? idx) + 0.3,
      })
      return copy
    })
    toast({ title: 'Clip split into 2' })
  }
  const deleteClip = (idx: number) => {
    setClips((cs) => cs.filter((_, i) => i !== idx))
    if (selectedIdx === idx) setSelectedIdx(null)
    setMultiSelected((prev) => {
      const next = new Set<number>()
      prev.forEach((i) => {
        if (i < idx) next.add(i)
        else if (i > idx) next.add(i - 1)
      })
      return next
    })
    toast({ title: 'Clip deleted' })
  }

  // inline edit
  const inlineEditTitle = (idx: number, v: string) => {
    setClips((cs) =>
      cs.map((c, i) =>
        i === idx && c.title !== v
          ? { ...c, title: v, status: c.status === 'suggested' ? 'edited' : c.status }
          : c,
      ),
    )
  }
  const inlineEditHook = (idx: number, v: string) => {
    setClips((cs) =>
      cs.map((c, i) =>
        i === idx && c.hookText !== v
          ? { ...c, hookText: v, status: c.status === 'suggested' ? 'edited' : c.status }
          : c,
      ),
    )
  }

  // ---- generate edit plan ----
  const handleGeneratePlan = React.useCallback(async () => {
    const idx = planClipIdx
    if (idx == null || !clips[idx] || !meta) return
    const c = clips[idx]
    if (!meta.duration || meta.duration <= 0) {
      toast({
        title: 'Duration required',
        description: 'A real video duration is needed to generate the plan. Enter it manually first.',
        variant: 'destructive',
      })
      return
    }
    setPlanLoading(true)
    setCurrentPlan(null)
    try {
      const res = await fetch('/api/clips/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: meta.title,
          author: meta.author,
          videoDuration: meta.duration,
          sourceDuration: meta.duration,
          projectId: projectId ?? undefined,
          clipId: c.id ?? `clip_${idx}`,
          clipStart: c.startTime,
          clipEnd: c.endTime,
          clipTitle: c.title,
          spokenHook: c.spokenHook ?? c.hookText,
          clipHook: c.hookText,
          clipReason: c.summary,
          clipScores: c.scores,
          clipTranscript: c.clipTranscript,
          clipWords: c.clipWords,
          platform: currentPlatform,
          style: currentStyle,
          targetDuration: currentTargetDuration,
          language: currentLanguage,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Plan generation failed')
      const plan: EditPlan = data.plan
      setCurrentPlan(plan)
      // mark clip as having plan + store plan fields
      setClips((cs) =>
        cs.map((cc, i) =>
          i === idx
            ? {
                ...cc,
                hasPlan: true,
                generatedHook: plan.selected_clip.generated_hook,
                segments: plan.selected_clip.segments,
                cuts: plan.selected_clip.cuts,
                camera: plan.selected_clip.camera,
                visuals: plan.selected_clip.visuals,
                animations: plan.selected_clip.animations,
                soundEffects: plan.selected_clip.sound_effects,
                music: plan.selected_clip.music,
                subtitles: plan.selected_clip.subtitles,
              }
            : cc,
        ),
      )
      const subsSource = (data as any)?.meta?.subtitlesSource
      toast({
        title: 'Edit plan generated',
        description:
          subsSource === 'deterministic'
            ? 'Subtitles rebuilt verbatim from transcript (AI text failed grounding check)'
            : subsSource === 'none'
              ? 'No transcript — subtitles omitted (ClipForge never invents speech)'
              : 'Full AI director plan ready (subtitles transcript-locked)',
      })
    } catch (e: any) {
      toast({
        title: 'Plan generation failed',
        description: e.message,
        variant: 'destructive',
      })
    } finally {
      setPlanLoading(false)
    }
  }, [planClipIdx, clips, meta, projectId, currentPlatform, currentStyle, currentTargetDuration, currentLanguage, toast])

  const openPlanView = (idx: number) => {
    setPlanClipIdx(idx)
    // if clip already has a plan stored, reconstruct it from the clip fields
    const c = clips[idx]
    if (c?.hasPlan && c.segments) {
      setCurrentPlan({
        project: {
          title: meta?.title ?? c.title,
          style: currentStyle,
          platform: currentPlatform,
          target_duration: currentTargetDuration,
          aspect_ratio: '9:16',
        },
        analysis: { main_topic: '', audience: '', content_type: '', overall_summary: '' },
        selected_clip: {
          id: c.id ?? '',
          start: c.startTime,
          end: c.endTime,
          duration: +(c.endTime - c.startTime).toFixed(1),
          title: c.title,
          generated_hook: c.generatedHook ?? '',
          segments: c.segments as any,
          cuts: c.cuts as any,
          camera: c.camera as any,
          visuals: c.visuals as any,
          animations: c.animations as any,
          sound_effects: c.soundEffects as any,
          music: c.music as any,
          subtitles: c.subtitles as any,
        },
      })
      setPlanLoading(false)
    } else {
      setCurrentPlan(null)
    }
    setPlanViewOpen(true)
  }

  // ---- timeline trim ----
  const trimStart = (idx: number, ns: number) => {
    setClips((cs) =>
      cs.map((c, i) =>
        i === idx
          ? { ...c, startTime: ns, status: c.status === 'suggested' ? 'edited' : c.status }
          : c,
      ),
    )
    if (selectedIdx === idx) setPlayStart(ns)
  }
  const trimEnd = (idx: number, ne: number) => {
    setClips((cs) =>
      cs.map((c, i) =>
        i === idx
          ? { ...c, endTime: ne, status: c.status === 'suggested' ? 'edited' : c.status }
          : c,
      ),
    )
  }

  // ---- keyboard shortcuts ----
  useKeyboardShortcuts({
    hasClips: clips.length > 0 && phase === 'done',
    onPrev: () => {
      if (selectedIdx == null) setSelectedIdx(clips.length - 1)
      else if (selectedIdx > 0) setSelectedIdx(selectedIdx - 1)
    },
    onNext: () => {
      if (selectedIdx == null) setSelectedIdx(0)
      else if (selectedIdx < clips.length - 1) setSelectedIdx(selectedIdx + 1)
    },
    onApprove: () => {
      if (selectedIdx != null) approveClip(selectedIdx)
    },
    onReject: () => {
      if (selectedIdx != null) rejectClip(selectedIdx)
    },
    onReset: () => {
      if (selectedIdx != null) resetClip(selectedIdx)
    },
    onEdit: () => {
      if (selectedIdx != null) openEditor(selectedIdx)
    },
    onPlay: () => {
      if (selectedIdx != null) playClip(selectedIdx)
    },
    onDuplicate: () => {
      if (selectedIdx != null) duplicateClip(selectedIdx)
    },
    onSplit: () => {
      if (selectedIdx != null) splitClip(selectedIdx)
    },
    onPlan: () => {
      if (selectedIdx != null) openPlanView(selectedIdx)
    },
    onSelectAll: selectAll,
    onClearSelection: clearSelection,
  })

  // ---- save to library ----
  const saveToLibrary = async () => {
    if (!meta) return
    setSaving(true)
    try {
      let pid = projectId
      if (!pid) {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            youtubeId: meta.youtubeId,
            url: meta.url,
            title: meta.title,
            author: meta.author,
            thumbnail: meta.thumbnail,
            description: meta.description,
            duration: meta.duration,
            durationSource: meta.durationSource ?? (meta.duration ? 'unknown' : 'unavailable'),
            // transcript is intentionally NOT sent here: the analyze route already
            // persisted the real transcript (with provenance) into the project when
            // one was available; sending it again would risk masking provenance.
            transcriptSource: analyzeResult?.transcriptSource,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        pid = data.project.id
        setProjectId(pid)
      }

      const payload = clips.map((c, i) => ({
        projectId: pid,
        title: c.title,
        summary: c.summary,
        startTime: c.startTime,
        endTime: c.endTime,
        score: c.score,
        tags: c.tags,
        hookText: c.hookText,
        spokenHook: c.spokenHook ?? c.hookText,
        hookVerified: c.hookVerified ?? false,
        platform: c.platform ?? 'shorts',
        status: c.status ?? 'suggested',
        order: i,
        style: c.style,
        targetDuration: c.targetDuration,
        scores: c.scores,
        contextRisk: c.contextRisk,
        contextStatus: c.contextStatus,
        recommendation: c.recommendation,
        generatedHook: c.generatedHook,
        reason: c.reason,
        clipTranscript: c.clipTranscript,
        clipWords: c.clipWords,
        segments: c.segments,
        cuts: c.cuts,
        camera: c.camera,
        visuals: c.visuals,
        animations: c.animations,
        soundEffects: c.soundEffects,
        music: c.music,
        subtitles: c.subtitles,
        hasPlan: c.hasPlan,
      }))
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      // keep the project's real duration in sync (manual entries included)
      if (meta.duration && meta.duration > 0) {
        await fetch(`/api/projects/${pid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: meta.duration, durationSource: meta.durationSource ?? 'user-provided' }),
        })
      }

      // bulk replace returns { count } — keep local ids (stable across re-saves)
      toast({
        title: 'Saved to library',
        description: `${data.count} clips saved (transactional replace — duplicates impossible). You can now export.`,
      })
      refreshProjects()
    } catch (e: any) {
      toast({
        title: 'Save failed',
        description: e.message,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  // ---- load project ----
  const loadProject = async (p: Project) => {
    try {
      const res = await fetch(`/api/projects/${p.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const proj = data.project
      const isUpload = String(proj.youtubeId ?? '').startsWith('upload-')
      const loadedMeta: YouTubeMeta = {
        youtubeId: proj.youtubeId,
        url: proj.url,
        title: proj.title,
        author: proj.author,
        thumbnail: proj.thumbnail ?? '',
        provider: isUpload ? 'Local upload' : 'YouTube',
        duration: proj.duration ?? null,
        durationSource: proj.durationSource ?? 'unknown',
        requiresManualDuration: proj.duration == null,
        description: proj.description,
        embedUrl: isUpload ? '' : `https://www.youtube.com/embed/${proj.youtubeId}`,
        embedUrlAutoplay: isUpload ? '' : `https://www.youtube.com/embed/${proj.youtubeId}?autoplay=1&rel=0`,
      }
      setMeta(loadedMeta)
      setProjectId(proj.id)
      setProjectMedia(
        proj.localMediaState || proj.localMedia
          ? { state: proj.localMediaState ?? null, size: proj.localMediaSize ?? null, error: proj.localMediaError ?? null }
          : null,
      )
      setSourceTranscript(proj.transcript ?? null)
      setSourceWords(parseDb(proj.transcriptWords) ?? null)
      setWordTiming(proj.wordTiming ?? null)
      const loadedClips: SuggestedClip[] = (proj.clips ?? []).map((c: any) => ({
        id: c.id,
        title: c.title,
        summary: c.summary ?? '',
        startTime: c.startTime,
        endTime: c.endTime,
        score: c.score,
        tags: safeTags(c.tags),
        hookText: c.spokenHook ?? c.hookText ?? '',
        spokenHook: c.spokenHook ?? '',
        hookVerified: c.hookVerified ?? false,
        platform: c.platform,
        status: c.status,
        order: c.order,
        style: c.style ?? undefined,
        targetDuration: c.targetDuration ?? undefined,
        scores: c.scores ? parseDb(c.scores) : undefined,
        contextRisk: c.contextRisk ?? false,
        contextStatus: c.contextStatus ?? undefined,
        recommendation: c.recommendation ?? undefined,
        generatedHook: c.generatedHook ?? undefined,
        reason: c.reason ?? undefined,
        clipTranscript: c.clipTranscript ?? undefined,
        clipWords: c.clipWords ? parseDb(c.clipWords) : undefined,
        segments: c.segments ? parseDb(c.segments) : undefined,
        cuts: c.cuts ? parseDb(c.cuts) : undefined,
        camera: c.camera ? parseDb(c.camera) : undefined,
        visuals: c.visuals ? parseDb(c.visuals) : undefined,
        animations: c.animations ? parseDb(c.animations) : undefined,
        soundEffects: c.soundEffects ? parseDb(c.soundEffects) : undefined,
        music: c.music ? parseDb(c.music) : undefined,
        subtitles: c.subtitles ? parseDb(c.subtitles) : undefined,
        hasPlan: c.hasPlan ?? false,
      }))
      setClips(loadedClips)
      setAnalyzeResult({
        clips: loadedClips,
        platform: 'shorts',
        contentSummary: '',
        estimatedDuration: proj.duration ?? 0,
        transcriptSource: proj.transcriptSource ?? 'none',
        transcriptGrounded: (proj.transcriptSource ?? 'none') !== 'none',
      })
      setSelectedIdx(null)
      setMultiSelected(new Set())
      setPlayStart(null)
      setError(null)
      setPhase('done')
      setTimeout(
        () => studioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        100,
      )
      toast({ title: 'Project loaded', description: proj.title.slice(0, 60) })
    } catch (e: any) {
      toast({
        title: 'Failed to load project',
        description: e.message,
        variant: 'destructive',
      })
    }
  }

  const deleteProject = async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      toast({ title: 'Project deleted' })
      if (projectId === id) {
        setProjectId(null)
        setProjectMedia(null)
      }
      refreshProjects()
    } catch (e: any) {
      toast({
        title: 'Delete failed',
        description: e.message,
        variant: 'destructive',
      })
    }
  }

  // ---- stats ----
  const stats = React.useMemo(() => {
    const approved = clips.filter((c) => c.status === 'approved').length
    const rejected = clips.filter((c) => c.status === 'rejected').length
    const edited = clips.filter((c) => c.status === 'edited').length
    const pending = clips.length - approved - rejected - edited
    const totalDur = clips.reduce((acc, c) => acc + (c.endTime - c.startTime), 0)
    const avgScore =
      clips.length > 0
        ? Math.round(clips.reduce((a, c) => a + c.score, 0) / clips.length)
        : 0
    return { approved, rejected, pending, edited, totalDur, avgScore, total: clips.length }
  }, [clips])

  const editClip = editIdx != null ? clips[editIdx] ?? null : null

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="flex-1">
        {/* ===== HERO ===== */}
        <section id="top" className="relative overflow-hidden">
          <div className="absolute inset-0 -z-10 bg-grid bg-grid-fade" />
          <div className="absolute inset-x-0 top-0 -z-10 h-64 bg-gradient-to-b from-primary/10 via-transparent to-transparent" />
          <div className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-72 w-[44rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />

          <div className="mx-auto max-w-7xl px-4 pb-12 pt-14 sm:px-6 sm:pt-20 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="mx-auto mb-8 max-w-3xl text-center"
            >
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles className="h-3 w-3" />
                AI-powered auto-clipping for YouTube creators
              </div>
              <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
                Turn any YouTube video into{' '}
                <span className="text-gradient-rose">viral clips</span> in seconds
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
                Paste a link. ClipForge AI reads the content, predicts the most
                shareable moments, and gives you timestamped clips with hooks,
                virality scores, and tags — ready for Shorts, Reels, and TikTok.
              </p>
            </motion.div>

            <UrlInput
              onAnalyze={handleAnalyze}
              loading={phase === 'fetching' || phase === 'analyzing' || reanalyzing}
              error={error}
            />

            <LivePreviewCard />
            <HeroStats />

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground"
            >
              <span className="inline-flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-primary" />
                No API key needed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Brain className="h-3.5 w-3.5 text-primary" />
                LLM-powered highlight detection
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Tags className="h-3.5 w-3.5 text-primary" />
                Auto SEO tags & hooks
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Scissors className="h-3.5 w-3.5 text-primary" />
                Trim, split, duplicate, bulk-approve
              </span>
            </motion.div>
          </div>
        </section>

        {/* ===== HOW IT WORKS ===== */}
        <section id="how" className="border-y border-border/40 bg-card/30">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="mb-8 text-center">
              <span className="mb-2 inline-block rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                Workflow
              </span>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                From link to viral clip in 3 steps
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                No login, no API keys, no upload. Just paste, analyze, and export.
              </p>
            </div>

            {/* progress connector */}
            <div className="relative mb-6 hidden md:block">
              <div className="absolute left-0 right-0 top-9 h-0.5 bg-border" />
              <motion.div
                initial={{ scaleX: 0 }}
                whileInView={{ scaleX: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 1.2, ease: 'easeInOut' }}
                style={{ transformOrigin: 'left' }}
                className="absolute left-0 right-0 top-9 h-0.5 bg-gradient-to-r from-primary via-primary/60 to-transparent"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {[
                {
                  icon: Film,
                  step: '01',
                  title: 'Paste a YouTube link',
                  desc: 'Drop any video URL. We fetch metadata instantly via YouTube oEmbed — no API key, no sign-in.',
                  tags: ['oEmbed', 'no auth', 'instant'],
                },
                {
                  icon: Brain,
                  step: '02',
                  title: 'AI finds the highlights',
                  desc: 'Our LLM analyzes the content, predicts the most viral moments, scores them on 7 dimensions, and writes hooks + SEO tags.',
                  tags: ['7D scoring', '8 styles', 'POST/SKIP'],
                },
                {
                  icon: Scissors,
                  step: '03',
                  title: 'Edit, approve & render',
                  desc: 'Trim on the visual timeline, generate a full AI edit plan, auto-edit preview live, and export as JSON/CSV/SRT/EDL or render with ffmpeg.',
                  tags: ['auto-edit', 'ffmpeg', '4 formats'],
                },
              ].map((s, i) => {
                const Icon = s.icon
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 12 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: i * 0.12 }}
                    className="group relative overflow-hidden rounded-2xl border border-border/60 bg-card/60 p-5 transition-all hover:border-primary/40 hover:shadow-xl"
                  >
                    {/* hover gradient */}
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                    <div className="relative">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="relative grid h-12 w-12 place-items-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
                          <Icon className="h-6 w-6" />
                          <span className="absolute -inset-1 -z-10 rounded-xl bg-primary/20 opacity-0 blur-md transition-opacity group-hover:opacity-100" />
                        </div>
                        <span className="font-mono text-2xl font-bold text-muted-foreground/20 transition-colors group-hover:text-primary/40">
                          {s.step}
                        </span>
                      </div>
                      <h3 className="text-base font-semibold">{s.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                        {s.desc}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {s.tags.map((t, ti) => (
                          <span key={ti} className="rounded-md bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                    {i < 2 && (
                      <motion.div
                        animate={{ x: [0, 4, 0] }}
                        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                        className="absolute -right-2 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 grid place-items-center rounded-full border border-border bg-card text-muted-foreground md:grid"
                      >
                        <ArrowRight className="h-3 w-3" />
                      </motion.div>
                    )}
                  </motion.div>
                )
              })}
            </div>
          </div>
        </section>

        {/* ===== FEATURES ===== */}
        <FeaturesGrid />

        {/* ===== STUDIO ===== */}
        <section id="studio" ref={studioRef} className="scroll-mt-20">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  Clipping Studio
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {phase === 'done'
                    ? 'Review AI-suggested clips, fine-tune, and export.'
                    : 'Paste a YouTube link above to begin.'}
                </p>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {phase === 'idle' && (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <EmptyStudio />
                </motion.div>
              )}

              {(phase === 'fetching' || phase === 'analyzing') && (
                <motion.div
                  key="analyzing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid place-items-center py-16"
                >
                  <AnalyzingState
                    stageText={prepareStage}
                    progress={prepareProgress}
                    prepareError={prepareError}
                    onRetryPrepare={handleRetryPrepare}
                    onSkipPrepare={handleSkipPrepare}
                  />
                </motion.div>
              )}

              {phase === 'done' && meta && (
                <motion.div
                  key="done"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="space-y-6"
                >
                  {/* content summary banner */}
                {analyzeResult?.contentSummary && (
                    <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Sparkles className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-primary">
                          AI Content Summary
                        </p>
                        <p className="mt-0.5 text-sm text-foreground/90">
                          {analyzeResult.contentSummary}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReanalyzeOpen((v) => !v)}
                        className="h-8 shrink-0 gap-1.5 text-xs"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        Re-analyze
                      </Button>
                    </div>
                  )}

                  <ReanalyzePanel
                    open={reanalyzeOpen}
                    onOpenChange={setReanalyzeOpen}
                    currentPlatform={currentPlatform}
                    currentStyle={currentStyle}
                    currentTargetDuration={currentTargetDuration}
                    currentCount={clips.length}
                    onReanalyze={handleReanalyze}
                    loading={reanalyzing}
                  />

                  {/* source data provenance */}
                  <SourceStatusPanel
                    meta={meta}
                    analyzeResult={analyzeResult}
                    transcript={sourceTranscript}
                    words={sourceWords}
                    wordTiming={wordTiming}
                    onOpenTranscript={() => setTranscriptOpen(true)}
                  />

                  {/* stats bar */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <StatCard
                      icon={<Scissors className="h-4 w-4" />}
                      label="Total clips"
                      value={String(stats.total)}
                      progress={stats.total > 0 ? 100 : 0}
                    />
                    <StatCard
                      icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      label="Approved"
                      value={`${stats.approved}/${stats.total}`}
                      accent="emerald"
                      progress={stats.total > 0 ? (stats.approved / stats.total) * 100 : 0}
                    />
                    <StatCard
                      icon={<Clock className="h-4 w-4" />}
                      label="Clip time"
                      value={fmtDuration(stats.totalDur)}
                      progress={stats.totalDur > 0 ? Math.min(100, (stats.totalDur / 600) * 100) : 0}
                    />
                    <StatCard
                      icon={<TrendingUp className="h-4 w-4" />}
                      label="Avg. score"
                      value={`${stats.avgScore}/100`}
                      accent={stats.avgScore >= 75 ? 'emerald' : stats.avgScore >= 50 ? 'amber' : 'rose'}
                      progress={stats.avgScore}
                    />
                    <StatCard
                      icon={<Wand2 className="h-4 w-4 text-sky-500" />}
                      label="Edited"
                      value={String(stats.edited)}
                      accent="sky"
                      progress={stats.total > 0 ? (stats.edited / stats.total) * 100 : 0}
                    />
                  </div>

                  {/* main workspace */}
                  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                    {/* left: preview + timeline */}
                    <div className="space-y-4">
                      <VideoPreview meta={meta} playStart={playStart} />
                      <Timeline
                        clips={clips}
                        duration={analyzeResult?.estimatedDuration ?? meta.duration ?? 0}
                        selectedId={selectedIdx != null ? clips[selectedIdx]?.id : undefined}
                        onSelect={(idx) => {
                          if (idx < 0) {
                            setSelectedIdx(null)
                            return
                          }
                          // find original index from clip
                          const oIdx = clips.findIndex((c) => c === displayClips[idx])
                          setSelectedIdx(oIdx >= 0 ? oIdx : idx)
                        }}
                        onTrimStart={trimStart}
                        onTrimEnd={trimEnd}
                        playStart={playStart}
                      />
                      {/* action bar */}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={saveToLibrary}
                          disabled={saving}
                          className="gap-2"
                        >
                          {saving ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="h-4 w-4" />
                          )}
                          {projectId ? 'Update library' : 'Save to library'}
                        </Button>
                        <Button
                          onClick={() => setExportOpen(true)}
                          variant="outline"
                          disabled={clips.length === 0}
                          className="gap-2"
                        >
                          <Download className="h-4 w-4" />
                          Export clips
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setPhase('idle')
                            setMeta(null)
                            setClips([])
                            setProjectId(null)
                            setProjectMedia(null)
                            setMultiSelected(new Set())
                          }}
                          className="gap-2 text-muted-foreground"
                        >
                          <Trash2 className="h-4 w-4" />
                          Clear
                        </Button>
                      </div>
                    </div>

                    {/* right: clips list */}
                    <div className="space-y-3">
                      {/* toolbar: bulk actions + sort/filter + shortcuts */}
                      <BulkActionBar
                        visible={clips.length > 0}
                        selectedCount={multiSelected.size}
                        totalCount={clips.length}
                        onApproveSelected={approveSelected}
                        onRejectSelected={rejectSelected}
                        onResetSelected={resetSelected}
                        onDeleteSelected={deleteSelected}
                        onDuplicateSelected={duplicateSelected}
                        onSplitSelected={splitSelected}
                        onApproveAll={approveAll}
                        onClearSelection={clearSelection}
                        onSelectAll={selectAll}
                      />

                      <div className="flex items-center justify-between gap-2">
                        <SortFilterBar
                          sort={sort}
                          filter={filter}
                          onSortChange={setSort}
                          onFilterChange={setFilter}
                          totalCount={clips.length}
                          filteredCount={displayClips.length}
                        />
                        <ShortcutsHint />
                      </div>

                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">
                          AI-suggested clips
                          <span className="ml-2 text-muted-foreground font-normal">
                            ({displayClips.length})
                          </span>
                        </h3>
                        <div className="flex gap-1.5">
                          <Badge variant="secondary" className="text-[10px]">
                            {stats.approved} approved
                          </Badge>
                          {stats.edited > 0 && (
                            <Badge variant="outline" className="text-[10px]">
                              {stats.edited} edited
                            </Badge>
                          )}
                          {stats.pending > 0 && (
                            <Badge variant="outline" className="text-[10px]">
                              {stats.pending} pending
                            </Badge>
                          )}
                        </div>
                      </div>

                      <div className="max-h-[640px] space-y-3 overflow-y-auto scrollbar-thin pr-1">
                        <AnimatePresence mode="popLayout">
                          {displayClips.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                              No clips match the current filter.
                            </div>
                          ) : (
                            displayClips.map((c, dIdx) => {
                              const oIdx = clips.indexOf(c)
                              return (
                                <ClipCard
                                  key={c.id ?? `local-${oIdx}`}
                                  clip={c}
                                  index={dIdx}
                                  selected={selectedIdx === oIdx}
                                  multiSelected={multiSelected.has(oIdx)}
                                  hasPlan={!!c.hasPlan}
                                  onToggleSelect={(e) => toggleMultiSelect(oIdx, e)}
                                  onApprove={() => approveClip(oIdx)}
                                  onReject={() => rejectClip(oIdx)}
                                  onReset={() => resetClip(oIdx)}
                                  onEdit={() => openEditor(oIdx)}
                                  onPlay={() => playClip(oIdx)}
                                  onDuplicate={() => duplicateClip(oIdx)}
                                  onSplit={() => splitClip(oIdx)}
                                  onInlineEditTitle={(v) => inlineEditTitle(oIdx, v)}
                                  onInlineEditHook={(v) => inlineEditHook(oIdx, v)}
                                  onGeneratePlan={() => openPlanView(oIdx)}
                                  onAutoEdit={() => {
                                    setPlanClipIdx(oIdx)
                                    // if clip has plan, reconstruct it; else generate fresh
                                    const c = clips[oIdx]
                                    if (c?.hasPlan && c.segments) {
                                      setCurrentPlan({
                                        project: { title: meta?.title ?? c.title, style: currentStyle, platform: currentPlatform, target_duration: currentTargetDuration, aspect_ratio: '9:16' },
                                        analysis: { main_topic: '', audience: '', content_type: '', overall_summary: '' },
                                        selected_clip: {
                                          id: c.id ?? '', start: c.startTime, end: c.endTime, duration: +(c.endTime - c.startTime).toFixed(1),
                                          title: c.title, generated_hook: c.generatedHook ?? '',
                                          segments: c.segments as any, cuts: c.cuts as any, camera: c.camera as any,
                                          visuals: c.visuals as any, animations: c.animations as any,
                                          sound_effects: c.soundEffects as any, music: c.music as any, subtitles: c.subtitles as any,
                                        },
                                      })
                                    } else {
                                      setCurrentPlan(null)
                                      // generate plan first then open auto-edit
                                      setPlanClipIdx(oIdx)
                                      handleGeneratePlan()
                                    }
                                    setAutoEditOpen(true)
                                  }}
                                />
                              )
                            })
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* ===== SAVED PROJECTS / RENDER ===== */}
        <section id="projects" className="scroll-mt-20 border-t border-border/40 bg-card/20">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  Library & Render
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Browse saved projects, or upload your own video and render a 9:16 vertical clip with the AI edit plan applied.
                </p>
              </div>
              {/* tab switcher */}
              <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/40 p-0.5">
                <button
                  onClick={() => setLibraryTab('library')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    libraryTab === 'library'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Film className="h-3.5 w-3.5" />
                  Library
                </button>
                <button
                  onClick={() => setLibraryTab('render')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    libraryTab === 'render'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  Render
                </button>
              </div>
            </div>

            {libraryTab === 'library' ? (
              <SavedProjects
                projects={savedProjects}
                loading={loadingProjects}
                onSelect={loadProject}
                onDelete={deleteProject}
                onRefresh={refreshProjects}
              />
            ) : (
              <div className="mx-auto max-w-2xl">
                <UploadRender plan={currentPlan} projectId={projectId} projectMedia={projectMedia} />
              </div>
            )}
          </div>
        </section>

        {/* ===== TUTORIAL ===== */}
        <Tutorial />
      </main>

      <Footer />

      {/* Dialogs */}
      <ClipEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        clip={editClip}
        duration={analyzeResult?.estimatedDuration ?? meta?.duration ?? 0}
        onSave={saveClipFromEditor}
      />
      <TranscriptViewer
        open={transcriptOpen}
        onOpenChange={setTranscriptOpen}
        title={meta?.title}
        transcript={sourceTranscript}
        words={sourceWords}
        source={analyzeResult?.transcriptSource ?? meta?.durationSource}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        projectId={projectId}
        clips={clips}
        projectTitle={meta?.title ?? 'Clips'}
      />
      <EditPlanView
        open={planViewOpen}
        onOpenChange={setPlanViewOpen}
        clip={planClipIdx != null ? clips[planClipIdx] ?? null : null}
        meta={meta}
        platform={currentPlatform}
        style={currentStyle}
        targetDuration={currentTargetDuration}
        loading={planLoading}
        plan={currentPlan}
        onGenerate={handleGeneratePlan}
        onAutoEdit={() => {
          setPlanViewOpen(false)
          setAutoEditOpen(true)
        }}
        onRemotionEdit={() => {
          setPlanViewOpen(false)
          setRemotionOpen(true)
        }}
      />
      <AutoEditPlayer
        plan={currentPlan}
        youtubeId={meta?.youtubeId ?? ''}
        open={autoEditOpen}
        onClose={() => setAutoEditOpen(false)}
      />
      <RemotionPlayer
        plan={currentPlan}
        youtubeId={meta?.youtubeId ?? ''}
        open={remotionOpen}
        onClose={() => setRemotionOpen(false)}
      />
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent,
  progress,
}: {
  icon: React.ReactNode
  label: string
  value: string
  accent?: 'emerald' | 'amber' | 'rose' | 'sky' | 'violet'
  progress?: number // 0-100 for progress bar
}) {
  const colorMap = {
    emerald: { ring: 'ring-emerald-500/20', bar: 'bg-emerald-500', glow: 'group-hover:shadow-emerald-500/20' },
    amber: { ring: 'ring-amber-500/20', bar: 'bg-amber-500', glow: 'group-hover:shadow-amber-500/20' },
    sky: { ring: 'ring-sky-500/20', bar: 'bg-sky-500', glow: 'group-hover:shadow-sky-500/20' },
    rose: { ring: 'ring-rose-500/20', bar: 'bg-rose-500', glow: 'group-hover:shadow-rose-500/20' },
    violet: { ring: 'ring-violet-500/20', bar: 'bg-violet-500', glow: 'group-hover:shadow-violet-500/20' },
  }
  const c = accent ? colorMap[accent] : { ring: '', bar: 'bg-primary', glow: '' }
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className={`group relative overflow-hidden rounded-xl border border-border/60 bg-card/60 p-3 ring-1 ${c.ring} transition-shadow ${c.glow} hover:shadow-lg`}
    >
      {/* corner accent */}
      <div className={`absolute -right-4 -top-4 h-10 w-10 rounded-full ${c.bar} opacity-10 blur-xl`} />
      <div className="relative flex items-center gap-2">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="relative mt-1.5 text-lg font-bold tabular-nums">{value}</p>
      {progress != null && (
        <div className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className={`h-full rounded-full ${c.bar}`}
          />
        </div>
      )}
    </motion.div>
  )
}

function EmptyStudio() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border bg-card/30 py-16 text-center">
      <div className="pointer-events-none absolute inset-0 bg-grid bg-grid-fade opacity-20" />
      <div className="pointer-events-none absolute -top-12 left-1/2 h-40 w-72 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      <div className="relative">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary shadow-lg shadow-primary/20"
        >
          <Wand2 className="h-10 w-10" />
        </motion.div>
        <h3 className="text-xl font-bold">Ready when you are</h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Paste a YouTube URL above and hit{' '}
          <span className="font-medium text-primary">Auto-Clip</span>. The AI
          will read the video&apos;s context and surface the most viral moments with
          timestamps, scores, hooks, and a full edit plan.
        </p>
        <div className="mx-auto mt-5 flex max-w-md flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-2.5 py-1">
            <Sparkles className="h-3 w-3 text-primary" />
            7-dimension scoring
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-2.5 py-1">
            <Scissors className="h-3 w-3 text-violet-500" />
            8 editing styles
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-2.5 py-1">
            <TrendingUp className="h-3 w-3 text-emerald-500" />
            POST/SKIP recs
          </span>
        </div>
      </div>
    </div>
  )
}

function safeTags(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** Parse a DB JSON string field into T (undefined when absent/corrupt). */
function parseDb<T>(raw: unknown): T | undefined {
  if (raw == null) return undefined
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v as T
  } catch {
    return undefined
  }
}

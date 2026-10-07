'use client'

import * as React from 'react'
import { BarChart3, Scissors, AudioLines, Clapperboard, Download, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface UsageSummary {
  totals: { kind: string; count: number; quantity: number }[]
  last30d: { kind: string; count: number; quantity: number }[]
  events: { id: string; kind: string; quantity: number; meta: unknown; createdAt: string }[]
}

const KIND_META: Record<string, { label: string; icon: React.ElementType; tone: string }> = {
  analyze: { label: 'AI analyses', icon: Scissors, tone: 'text-violet-500' },
  prepare: { label: 'Source preps', icon: Download, tone: 'text-sky-500' },
  transcribe: { label: 'ASR minutes', icon: AudioLines, tone: 'text-emerald-500' },
  render: { label: 'Renders', icon: Clapperboard, tone: 'text-amber-500' },
}

function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * Usage metering panel (light): shows engine action counts for this session.
 * The local-mode read side of what becomes plan limits/billing later
 * (docs/SAAS-MIGRATION.md §7-8). Loads lazily on first open.
 */
export function UsagePanel() {
  const [open, setOpen] = React.useState(false)
  const [data, setData] = React.useState<UsageSummary | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/usage')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load usage')
      setData(json as UsageSummary)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open && !data && !loading) void load()
  }, [open, data, loading, load])

  const totalOf = (rows: UsageSummary['totals']) => rows.reduce((a, r) => a + r.count, 0)
  const qty = (rows: UsageSummary['totals'], kind: string) => rows.find((r) => r.kind === kind)?.quantity ?? 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5 transition-colors hover:border-primary/40 hover:bg-card/60"
          title="Engine usage for this session"
        >
          <BarChart3 className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs text-muted-foreground">Usage</span>
          {data && (
            <span className="text-sm font-semibold tabular-nums">{totalOf(data.last30d)}</span>
          )}
          {!data && <span className="text-sm font-semibold tabular-nums">—</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold">Engine usage</p>
          <span className="text-[10px] text-muted-foreground">last 30 days · this session</span>
        </div>

        {loading && !data && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <p className="py-3 text-xs text-destructive">{error}</p>}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(KIND_META).map(([kind, meta]) => {
                const Icon = meta.icon
                const row = data.last30d.find((r) => r.kind === kind)
                return (
                  <div key={kind} className="rounded-lg border border-border/50 bg-card/40 p-2.5">
                    <div className="flex items-center gap-1.5">
                      <Icon className={`h-3 w-3 ${meta.tone}`} />
                      <span className="text-[10px] text-muted-foreground">{meta.label}</span>
                    </div>
                    <div className="mt-1 flex items-baseline gap-1">
                      <span className="text-lg font-bold tabular-nums">{row?.count ?? 0}</span>
                      {kind === 'transcribe' && row && row.quantity > 0 && (
                        <span className="text-[9px] text-muted-foreground">({Math.round(row.quantity)}s media)</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {data.events.length > 0 && (
              <>
                <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent activity
                </div>
                <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                  {data.events.slice(0, 8).map((ev) => (
                    <div key={ev.id} className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-[10px]">
                      <span className="flex items-center gap-1.5">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${KIND_META[ev.kind] ? 'bg-current ' + KIND_META[ev.kind].tone : 'bg-muted-foreground'}`} />
                        <span className="capitalize text-foreground">{ev.kind}</span>
                        {ev.quantity !== 1 && <span className="text-muted-foreground tabular-nums">×{Math.round(ev.quantity)}s</span>}
                      </span>
                      <span className="text-muted-foreground tabular-nums">{fmtAgo(ev.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {data.events.length === 0 && (
              <p className="mt-3 text-center text-[10px] text-muted-foreground">
                No engine actions yet — analyze a video to see usage here.
              </p>
            )}
            <div className="mt-3 border-t border-border/40 pt-2 text-[9px] leading-snug text-muted-foreground">
              Local mode: metering is informational. In SaaS mode these events become plan limits & billing
              (docs/SAAS-MIGRATION.md §7).
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

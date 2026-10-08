'use client'

import * as React from 'react'
import { ArrowDownWideNarrow, Filter, X } from 'lucide-react'

export type SortKey = 'default' | 'score-desc' | 'score-asc' | 'time-asc' | 'duration-desc'
export type FilterKey = 'all' | 'approved' | 'pending' | 'rejected' | 'edited'

interface Props {
  sort: SortKey
  filter: FilterKey
  onSortChange: (s: SortKey) => void
  onFilterChange: (f: FilterKey) => void
  totalCount: number
  filteredCount: number
}

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'default', label: 'Default order' },
  { id: 'score-desc', label: 'Score: High → Low' },
  { id: 'score-asc', label: 'Score: Low → High' },
  { id: 'time-asc', label: 'Time: Earliest first' },
  { id: 'duration-desc', label: 'Duration: Longest first' },
]

const FILTER_OPTIONS: { id: FilterKey; label: string }[] = [
  { id: 'all', label: 'All clips' },
  { id: 'approved', label: 'Approved' },
  { id: 'pending', label: 'Pending' },
  { id: 'edited', label: 'Edited' },
  { id: 'rejected', label: 'Rejected' },
]

export function SortFilterBar({
  sort,
  filter,
  onSortChange,
  onFilterChange,
  totalCount,
  filteredCount,
}: Props) {
  const [sortOpen, setSortOpen] = React.useState(false)
  const [filterOpen, setFilterOpen] = React.useState(false)
  const sortRef = React.useRef<HTMLDivElement>(null)
  const filterRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false)
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const sortLabel = SORT_OPTIONS.find((o) => o.id === sort)?.label ?? 'Sort'
  const filterLabel = FILTER_OPTIONS.find((o) => o.id === filter)?.label ?? 'Filter'

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* sort */}
      <div ref={sortRef} className="relative">
        <button
          type="button"
          onClick={() => {
            setSortOpen((v) => !v)
            setFilterOpen(false)
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <ArrowDownWideNarrow className="h-3.5 w-3.5" />
          {sortLabel}
        </button>
        {sortOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border bg-popover p-1 shadow-lg">
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  onSortChange(o.id)
                  setSortOpen(false)
                }}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent ${
                  sort === o.id ? 'text-primary font-medium' : 'text-muted-foreground'
                }`}
              >
                {o.label}
                {sort === o.id && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* filter */}
      <div ref={filterRef} className="relative">
        <button
          type="button"
          onClick={() => {
            setFilterOpen((v) => !v)
            setSortOpen(false)
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Filter className="h-3.5 w-3.5" />
          {filterLabel}
          {filter !== 'all' && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
              {filteredCount}
            </span>
          )}
        </button>
        {filterOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 w-36 rounded-lg border bg-popover p-1 shadow-lg">
            {FILTER_OPTIONS.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  onFilterChange(o.id)
                  setFilterOpen(false)
                }}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent ${
                  filter === o.id ? 'text-primary font-medium' : 'text-muted-foreground'
                }`}
              >
                {o.label}
                {filter === o.id && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </button>
            ))}
            {filter !== 'all' && (
              <button
                onClick={() => {
                  onFilterChange('all')
                  setFilterOpen(false)
                }}
                className="mt-1 flex w-full items-center gap-1 border-t border-border/40 pt-1 text-xs text-rose-500 hover:text-rose-600"
              >
                <X className="h-3 w-3" />
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {filteredCount === totalCount
          ? `${totalCount} clips`
          : `${filteredCount} / ${totalCount} clips`}
      </span>
    </div>
  )
}

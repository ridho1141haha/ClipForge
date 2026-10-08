'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Check,
  CheckCheck,
  X,
  RotateCcw,
  Trash2,
  Copy,
  Scissors,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  visible: boolean
  selectedCount: number
  totalCount: number
  onApproveSelected: () => void
  onRejectSelected: () => void
  onResetSelected: () => void
  onDeleteSelected: () => void
  onDuplicateSelected: () => void
  onSplitSelected: () => void
  onApproveAll: () => void
  onClearSelection: () => void
  onSelectAll: () => void
}

export function BulkActionBar({
  visible,
  selectedCount,
  totalCount,
  onApproveSelected,
  onRejectSelected,
  onResetSelected,
  onDeleteSelected,
  onDuplicateSelected,
  onSplitSelected,
  onApproveAll,
  onClearSelection,
  onSelectAll,
}: Props) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 p-2.5 shadow-lg shadow-primary/10">
            <div className="flex items-center gap-2 px-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
                {selectedCount}
              </span>
              <span className="text-xs font-medium text-foreground">
                {selectedCount === 0 ? 'No clips' : selectedCount === totalCount ? 'All clips' : `${selectedCount} selected`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {selectedCount > 0 ? (
                <>
                  <ActionBtn onClick={onApproveSelected} icon={<Check className="h-3.5 w-3.5" />} label="Approve" tone="emerald" />
                  <ActionBtn onClick={onRejectSelected} icon={<X className="h-3.5 w-3.5" />} label="Reject" tone="rose" />
                  <ActionBtn onClick={onResetSelected} icon={<RotateCcw className="h-3.5 w-3.5" />} label="Reset" />
                  <ActionBtn onClick={onDuplicateSelected} icon={<Copy className="h-3.5 w-3.5" />} label="Duplicate" />
                  <ActionBtn onClick={onSplitSelected} icon={<Scissors className="h-3.5 w-3.5" />} label="Split" />
                  <ActionBtn onClick={onDeleteSelected} icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete" tone="rose" />
                </>
              ) : (
                <>
                  <ActionBtn onClick={onApproveAll} icon={<CheckCheck className="h-3.5 w-3.5" />} label="Approve all" tone="emerald" />
                  <ActionBtn onClick={onSelectAll} icon={<Check className="h-3.5 w-3.5" />} label="Select all" />
                </>
              )}
            </div>

            <div className="ml-auto flex items-center gap-1">
              {selectedCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onClearSelection}
                  className="h-7 gap-1 px-2 text-xs"
                >
                  Clear
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ActionBtn({
  onClick,
  icon,
  label,
  tone,
}: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  tone?: 'emerald' | 'rose'
}) {
  const toneCls =
    tone === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10'
      : tone === 'rose'
      ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-500/10'
      : 'text-muted-foreground hover:bg-muted'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${toneCls}`}
    >
      {icon}
      {label}
    </button>
  )
}

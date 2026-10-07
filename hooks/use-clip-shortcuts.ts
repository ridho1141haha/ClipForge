'use client'

import * as React from 'react'

export interface KeyboardShortcuts {
  onPrev: () => void
  onNext: () => void
  onApprove: () => void
  onReject: () => void
  onReset: () => void
  onEdit: () => void
  onPlay: () => void
  onDuplicate: () => void
  onSplit: () => void
  onPlan: () => void
  onSelectAll: () => void
  onClearSelection: () => void
  hasClips: boolean
}

export function useKeyboardShortcuts(s: KeyboardShortcuts) {
  React.useEffect(() => {
    if (!s.hasClips) return
    const handler = (e: KeyboardEvent) => {
      // ignore when typing in input/textarea/contenteditable
      const target = e.target as HTMLElement
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.getAttribute('role') === 'textbox')
      ) {
        return
      }
      // ignore if a dialog is open
      if (document.querySelector('[role="dialog"]:not([data-state="closed"])')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const k = e.key.toLowerCase()
      switch (k) {
        case 'j':
          e.preventDefault()
          s.onPrev()
          break
        case 'k':
          e.preventDefault()
          s.onNext()
          break
        case 'a':
          e.preventDefault()
          s.onApprove()
          break
        case 'r':
          e.preventDefault()
          s.onReject()
          break
        case 'u':
          e.preventDefault()
          s.onReset()
          break
        case 'e':
          e.preventDefault()
          s.onEdit()
          break
        case ' ':
          e.preventDefault()
          s.onPlay()
          break
        case 'd':
          e.preventDefault()
          s.onDuplicate()
          break
        case 's':
          e.preventDefault()
          s.onSplit()
          break
        case 'p':
          e.preventDefault()
          s.onPlan()
          break
        case 'escape':
          s.onClearSelection()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [s])
}

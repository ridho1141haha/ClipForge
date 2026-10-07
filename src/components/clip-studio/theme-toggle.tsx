'use client'

import * as React from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const options: { id: 'dark' | 'light' | 'system'; label: string; icon: React.ReactNode }[] = [
    { id: 'dark', label: 'Dark', icon: <Moon className="h-3.5 w-3.5" /> },
    { id: 'light', label: 'Light', icon: <Sun className="h-3.5 w-3.5" /> },
    { id: 'system', label: 'System', icon: <Monitor className="h-3.5 w-3.5" /> },
  ]

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-lg"
        onClick={() => setOpen((v) => !v)}
        aria-label="Toggle theme"
      >
        {resolvedTheme === 'dark' ? (
          <Moon className="h-4 w-4" />
        ) : (
          <Sun className="h-4 w-4" />
        )}
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-36 rounded-lg border bg-popover p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                setTheme(o.id)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-accent ${
                theme === o.id ? 'text-primary font-medium' : 'text-muted-foreground'
              }`}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

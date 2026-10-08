'use client'

import * as React from 'react'

type Theme = 'dark' | 'light' | 'system'

const ThemeContext = React.createContext<{
  theme: Theme
  setTheme: (t: Theme) => void
  resolvedTheme: 'dark' | 'light'
}>({
  theme: 'dark',
  setTheme: () => {},
  resolvedTheme: 'dark',
})

const STORAGE_KEY = 'clipforge-theme'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>('dark')
  const [resolvedTheme, setResolvedTheme] = React.useState<'dark' | 'light'>('dark')

  React.useEffect(() => {
    const stored = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) as Theme | null
    const initial: Theme = stored ?? 'dark'
    setThemeState(initial)
  }, [])

  React.useEffect(() => {
    const root = document.documentElement
    const apply = (t: 'dark' | 'light') => {
      root.classList.remove('light', 'dark')
      root.classList.add(t)
      root.style.colorScheme = t
      setResolvedTheme(t)
    }
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      apply(mq.matches ? 'dark' : 'light')
      const handler = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    apply(theme)
  }, [theme])

  const setTheme = React.useCallback((t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {}
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return React.useContext(ThemeContext)
}

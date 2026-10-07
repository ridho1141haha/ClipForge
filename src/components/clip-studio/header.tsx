'use client'

import * as React from 'react'
import { Scissors, Github, Sparkles, ArrowUpRight } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { Button } from '@/components/ui/button'

export function Header() {
  const [scrolled, setScrolled] = React.useState(false)
  const [activeSection, setActiveSection] = React.useState('top')

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  React.useEffect(() => {
    const sections = ['top', 'how', 'studio', 'projects']
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActiveSection(e.target.id)
          }
        }
      },
      { rootMargin: '-40% 0px -50% 0px' },
    )
    sections.forEach((id) => {
      const el = document.getElementById(id)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [])

  const navLinks = [
    { id: 'how', label: 'How it works' },
    { id: 'studio', label: 'Studio' },
    { id: 'projects', label: 'Library' },
  ]

  return (
    <header
      className={`sticky top-0 z-40 w-full border-b transition-all duration-200 ${
        scrolled
          ? 'border-border/60 bg-background/85 backdrop-blur-xl shadow-sm supports-[backdrop-filter]:bg-background/70'
          : 'border-transparent bg-background/60 backdrop-blur-md'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="#top" className="group flex items-center gap-2.5">
          <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition-transform group-hover:scale-105 group-hover:rotate-3">
            <Scissors className="h-5 w-5" strokeWidth={2.5} />
            <span className="absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full bg-amber-400 text-[8px] font-bold text-black ring-2 ring-background">
              AI
            </span>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-semibold tracking-tight text-foreground">
              ClipForge<span className="text-primary"> AI</span>
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Auto-Clipping Studio
            </span>
          </div>
        </a>

        <nav className="hidden items-center gap-0.5 md:flex">
          {navLinks.map((l) => (
            <a
              key={l.id}
              href={`#${l.id}`}
              className={`relative rounded-md px-3 py-1.5 text-sm transition-colors ${
                activeSection === l.id
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {l.label}
              {activeSection === l.id && (
                <span className="absolute inset-x-2.5 -bottom-0.5 h-0.5 rounded-full bg-primary" />
              )}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary sm:flex">
            <Sparkles className="h-3 w-3" />
            Beta
          </div>
          <ThemeToggle />
          <a
            href="https://chat.z.ai"
            target="_blank"
            rel="noreferrer"
            className="hidden h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:grid"
            aria-label="Open Z.ai"
          >
            <Github className="h-4 w-4" />
          </a>
          <Button
            asChild
            size="sm"
            className="hidden gap-1.5 sm:inline-flex"
          >
            <a href="#studio">
              Start clipping
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </div>
    </header>
  )
}

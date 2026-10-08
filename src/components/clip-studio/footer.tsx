'use client'

import { Scissors, Heart, Sparkles, Github, Zap, Shield, Code2 } from 'lucide-react'

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/60">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* top: brand + nav + tech */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* brand */}
          <div>
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
                <Scissors className="h-4 w-4" />
              </div>
              <span className="font-semibold text-foreground">
                ClipForge<span className="text-primary"> AI</span>
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              The AI-assisted YouTube clip studio. Paste a link — get viral
              highlight clips with multi-dimensional scores, hooks, and a full
              edit plan ready to render.
            </p>
            <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" />
              Built with the Z.ai web-dev-sdk
            </div>
          </div>

          {/* nav */}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Navigate
            </p>
            <ul className="space-y-2 text-xs">
              <li>
                <a href="#top" className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary">
                  <span className="h-1 w-1 rounded-full bg-primary/40" />
                  Studio
                </a>
              </li>
              <li>
                <a href="#how" className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary">
                  <span className="h-1 w-1 rounded-full bg-primary/40" />
                  How it works
                </a>
              </li>
              <li>
                <a href="#projects" className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary">
                  <span className="h-1 w-1 rounded-full bg-primary/40" />
                  Your clip library
                </a>
              </li>
            </ul>
          </div>

          {/* tech */}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Built with
            </p>
            <div className="flex flex-wrap gap-1.5">
              {['Next.js 16', 'TypeScript', 'Tailwind 4', 'shadcn/ui', 'Prisma', 'SQLite', 'Framer Motion', 'z-ai-sdk', 'ffmpeg'].map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Zap className="h-3 w-3 text-amber-500" />
                No API key
              </span>
              <span className="inline-flex items-center gap-1">
                <Shield className="h-3 w-3 text-emerald-500" />
                Context-safe
              </span>
            </div>
          </div>
        </div>

        {/* divider */}
        <div className="my-6 h-px bg-border/40" />

        {/* bottom: copyright + disclaimer */}
        <div className="flex flex-col items-center justify-between gap-3 text-[11px] text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-1.5">
            <span>© {new Date().getFullYear()} ClipForge AI</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="inline-flex items-center gap-1">
              Made with <Heart className="h-2.5 w-2.5 fill-primary text-primary" /> for creators
            </span>
          </div>
          <p className="max-w-md text-center sm:text-right">
            AI suggestions are estimates — always verify before publishing.
            Respect YouTube&apos;s ToS and creators&apos; rights.
          </p>
        </div>
      </div>
    </footer>
  )
}

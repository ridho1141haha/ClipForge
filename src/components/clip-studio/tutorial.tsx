'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ClipboardPaste,
  Brain,
  Scissors,
  Play,
  Download,
  UploadCloud,
  CheckCircle2,
  ChevronDown,
  Terminal,
  Youtube,
  Zap,
  Film,
  Sparkles,
  Lightbulb,
  AlertTriangle,
  Languages,
  Radio,
  Camera,
  Type,
  Volume2,
} from 'lucide-react'

const TUTORIALS = [
  {
    id: 'quickstart',
    icon: Zap,
    title: 'Quick Start',
    desc: 'Get your first clip in under 2 minutes',
    accent: 'text-amber-500',
    bg: 'bg-amber-500/10',
  },
  {
    id: 'language',
    icon: Languages,
    title: 'Subtitle Language',
    desc: 'Force subtitles to match your video language (Bahasa Indonesia, English, etc.)',
    accent: 'text-cyan-500',
    bg: 'bg-cyan-500/10',
  },
  {
    id: 'vod',
    icon: Radio,
    title: 'Clip a Stream VOD',
    desc: 'Clip finished live streams (YouTube Live, Twitch VOD, podcasts)',
    accent: 'text-rose-500',
    bg: 'bg-rose-500/10',
  },
  {
    id: 'edit-plan',
    icon: Sparkles,
    title: 'AI Edit Plan',
    desc: 'Generate a full structured edit plan with segments, subtitles, camera & sound',
    accent: 'text-violet-500',
    bg: 'bg-violet-500/10',
  },
  {
    id: 'remotion',
    icon: Film,
    title: 'Remotion Editor',
    desc: 'Interactive React-based video editor — scrub the timeline and see edits live',
    accent: 'text-fuchsia-500',
    bg: 'bg-fuchsia-500/10',
  },
  {
    id: 'auto-edit',
    icon: Play,
    title: 'Auto-Edit Preview',
    desc: 'Watch the edit plan applied live to the YouTube video',
    accent: 'text-orange-500',
    bg: 'bg-orange-500/10',
  },
  {
    id: 'render',
    icon: UploadCloud,
    title: 'Render MP4',
    desc: 'Upload your video and render it into a 9:16 vertical clip',
    accent: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
  },
  {
    id: 'local',
    icon: Terminal,
    title: 'Local Render Script',
    desc: 'Download a ffmpeg script and render locally (with optional yt-dlp)',
    accent: 'text-sky-500',
    bg: 'bg-sky-500/10',
  },
]

export function Tutorial() {
  const [open, setOpen] = React.useState<string>('quickstart')

  return (
    <section id="tutorial" className="scroll-mt-20 border-t border-border/40 bg-card/20">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-8 text-center">
          <span className="mb-2 inline-block rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Tutorial
          </span>
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            How to use ClipForge AI
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-muted-foreground">
            Step-by-step guides from your first clip to rendering a finished vertical video.
          </p>
        </div>

        {/* tutorial tabs */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {TUTORIALS.map((t) => {
            const Icon = t.icon
            const active = open === t.id
            return (
              <button
                key={t.id}
                onClick={() => setOpen(t.id)}
                className={`group relative overflow-hidden rounded-xl border p-3 text-left transition-all ${
                  active
                    ? 'border-primary bg-primary/5 shadow-md'
                    : 'border-border/60 bg-card/40 hover:border-primary/40 hover:bg-card/60'
                }`}
              >
                <div className={`mb-2 grid h-9 w-9 place-items-center rounded-lg ${t.bg} ${t.accent}`}>
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <p className="text-xs font-semibold">{t.title}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                  {t.desc}
                </p>
              </button>
            )
          })}
        </div>

        {/* tutorial content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={open}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="mt-6 rounded-2xl border border-border/60 bg-card/60 p-6"
          >
            {open === 'quickstart' && <QuickStartTutorial />}
            {open === 'language' && <LanguageTutorial />}
            {open === 'vod' && <VODTutorial />}
            {open === 'edit-plan' && <EditPlanTutorial />}
            {open === 'remotion' && <RemotionTutorial />}
            {open === 'auto-edit' && <AutoEditTutorial />}
            {open === 'render' && <RenderTutorial />}
            {open === 'local' && <LocalRenderTutorial />}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}

// ---- shared sub-components ----

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="relative shrink-0">
        <div className="grid h-7 w-7 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
          {n}
        </div>
        {n < 99 && <div className="absolute left-1/2 top-7 h-[calc(100%-1rem)] w-px -translate-x-1/2 bg-border/40" />}
      </div>
      <div className="flex-1 pb-6">
        <p className="text-sm font-semibold">{title}</p>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

function Callout({ type = 'tip', children }: { type?: 'tip' | 'warn' | 'info'; children: React.ReactNode }) {
  const cfg = {
    tip: { icon: Lightbulb, color: 'text-amber-500', bg: 'bg-amber-500/5 border-amber-500/20' },
    warn: { icon: AlertTriangle, color: 'text-rose-500', bg: 'bg-rose-500/5 border-rose-500/20' },
    info: { icon: Sparkles, color: 'text-sky-500', bg: 'bg-sky-500/5 border-sky-500/20' },
  }[type]
  const Icon = cfg.icon
  return (
    <div className={`mt-3 flex items-start gap-2 rounded-lg border p-2.5 ${cfg.bg}`}>
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cfg.color}`} />
      <div className="text-xs">{children}</div>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  )
}

function CodeBlock({ children, lang }: { children: string; lang?: string }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-background/60">
      {lang && (
        <div className="border-b border-border/40 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed scrollbar-thin">
        <code className="font-mono text-muted-foreground">{children}</code>
      </pre>
    </div>
  )
}

// ---- tutorials ----

function QuickStartTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Quick Start — your first clip in 2 minutes</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The fastest path from a YouTube link to a list of viral clip candidates with scores and hooks.
      </p>
      <div className="mt-5">
        <Step n={1} title="Paste a YouTube URL">
          At the top of the page, paste any YouTube video link into the input box.
          You can use any format: <Code>youtube.com/watch?v=…</Code>, <Code>youtu.be/…</Code>, or <Code>youtube.com/shorts/…</Code>.
        </Step>
        <Step n={2} title="Pick platform, style, length & clip count">
          Choose your target platform (<span className="text-amber-500">⚡ Shorts</span>, <span className="text-violet-500">📸 Reels</span>, <span className="text-sky-500">🎵 TikTok</span>),
          an editing style (🎙️ Podcast, 💼 Business, 📚 Educational, etc.), the target clip length (15–120s), and how many clips to find (3–10).
        </Step>
        <Step n={3} title="Click “Auto-Clip”">
          Click the <span className="font-medium text-primary">Auto-Clip</span> button. The AI fetches the video metadata, analyzes the content, and proposes scored candidates — usually in under 15 seconds.
        </Step>
        <Step n={4} title="Review the clip cards">
          Each card shows a timestamped clip with a title, score (0–100), POST/SKIP recommendation, 7-dimension score breakdown, spoken hook, SEO tags, and a summary.
          Click <span className="font-medium">Score breakdown</span> to expand all 7 dimensions.
        </Step>
        <Step n={5} title="Approve, reject, edit, or generate a plan">
          Use the <CheckCircle2 className="inline h-3 w-3 text-emerald-500" /> approve / <span className="text-rose-500">✕</span> reject buttons,
          or click <span className="font-medium text-primary">AI plan</span> to generate a full structured edit plan for that clip.
        </Step>
        <Step n={99} title="Done!">
          You now have a list of AI-scored clip candidates. Save them to your library, export as JSON/CSV/SRT/EDL, or generate a full edit plan and render.
        </Step>
      </div>
      <Callout type="tip">
        Try the example links under the input (<Code>Podcast</Code>, <Code>Talk</Code>) for quick testing.
      </Callout>
    </div>
  )
}

function EditPlanTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">AI Edit Plan — segments, subtitles, camera & sound</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Go beyond clip selection: generate a full structured edit plan that a video renderer can execute.
      </p>
      <div className="mt-5">
        <Step n={1} title="Generate the plan">
          On any clip card, click <span className="font-medium text-primary">AI plan</span>. The AI Creative Director composes a plan in ~15 seconds covering 13 stages: content analysis, hook optimization, segment structure, subtitles, camera moves, visuals, animations, sound design, pacing, style preset, and context safety.
        </Step>
        <Step n={2} title="Explore the 7 tabs">
          The Edit Plan dialog has 7 tabs:
          <ul className="mt-1.5 ml-3 list-disc space-y-0.5">
            <li><b>Segments</b> — colored timeline (HOOK → CONTEXT → DEVELOPMENT → PAYOFF)</li>
            <li><b>Subtitles</b> — mobile-optimized blocks with emphasized words highlighted</li>
            <li><b>Visuals</b> — B-roll / generated-image prompts (9:16) with purpose</li>
            <li><b>Cuts</b> — recommended removals with reasons</li>
            <li><b>Camera</b> — punch-in movements (1.0–1.18×) with visualization</li>
            <li><b>Sound</b> — music plan + SFX (whoosh, impact, pop) with intensity</li>
            <li><b>JSON</b> — raw structured plan, copyable</li>
          </ul>
        </Step>
        <Step n={3} title="Check the on-screen hook">
          The dialog shows a <span className="font-medium text-primary">generated on-screen hook</span> (clearly separated from spoken dialogue) — use it as title-card text for your short.
        </Step>
        <Step n={4} title="Mind the context risk">
          If a clip is flagged <span className="text-rose-500 font-medium">ctx risk</span>, the AI thinks it might mislead the speaker without more context. Consider extending the clip range or skipping it.
        </Step>
        <Step n={5} title="Regenerate or copy">
          Click <span className="font-medium">Regenerate</span> to get a fresh plan, or <span className="font-medium">Copy JSON</span> to paste it into your own pipeline.
        </Step>
      </div>
      <Callout type="info">
        Plans persist with the clip — when you save to library and reopen, the plan is still there.
      </Callout>
    </div>
  )
}

function AutoEditTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Auto-Edit Preview — watch the plan apply live</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A full-screen player that applies your edit plan to the YouTube video in real-time — no rendering needed.
      </p>
      <div className="mt-5">
        <Step n={1} title="Open the Auto-Edit player">
          From any clip card with a plan, click the <span className="font-medium text-primary">Auto-Edit</span> button. Or from the Edit Plan dialog, click <span className="font-medium">Auto-Edit Preview</span>.
        </Step>
        <Step n={2} title="Press play">
          The player loads the YouTube video. Click the play button to start playback. Because of browser autoplay policies, you&apos;ll need to click play directly on the player the first time.
        </Step>
        <Step n={3} title="Watch the effects apply in real time">
          As the video plays, the player applies:
          <ul className="mt-1.5 ml-3 list-disc space-y-0.5">
            <li><b>Auto-cut skipping</b> — when playback hits a cut region, it auto-seeks to the end and flashes “cut skipped”</li>
            <li><b>Punch-in zoom</b> — the iframe scales up to 1.18× following the camera keyframes</li>
            <li><b>Animated subtitles</b> — subtitle overlays appear synchronized with speech, emphasis words highlighted</li>
            <li><b>Segment badges</b> — HOOK / CONTEXT / DEVELOPMENT / PAYOFF colored badge in the corner</li>
            <li><b>Visual cards</b> — B-roll prompt overlays at the right timestamps</li>
            <li><b>Sound effects</b> — synthesized via Web Audio (whoosh, pop, impact) at the right moments</li>
          </ul>
        </Step>
        <Step n={4} title="Use the controls">
          <span className="font-medium">Play/pause</span>, restart, back/forward 5s, speed (0.5×/1×/1.5×/2×), mute, and a seek slider with segment + cut markers on the progress bar.
        </Step>
        <Step n={5} title="Monitor the Live Edit State panel">
          The right panel shows real-time state: source time, clip progress %, current camera scale, in-cut status, current segment/subtitle/visual, and plan summary counts.
        </Step>
      </div>
      <Callout type="tip">
        Use the speed controls (0.5×) to study exactly where cuts happen. Use 2× to skim through quickly.
      </Callout>
    </div>
  )
}

function RenderTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Render MP4 — upload your video and get a 9:16 vertical clip</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        When you want an actual MP4 file (not just a preview), use the Render panel in the Library tab.
      </p>
      <div className="mt-5">
        <Step n={1} title="Generate an edit plan first">
          You need a plan on at least one clip — the render engine uses the plan to know which cuts to make, subtitles to burn, and zoom to apply.
        </Step>
        <Step n={2} title="Open the Library section">
          Scroll down to <span className="font-medium">Your clip library</span> and switch to the <span className="font-medium text-primary">Render</span> tab.
        </Step>
        <Step n={3} title="Upload your source video">
          Drag and drop your source video into the upload box, or click to browse. Supported: MP4, MOV, WebM, AVI (up to ~500MB).
          <Callout type="warn">
            For YouTube content, you need to download the video yourself first (use yt-dlp, 4K Video Downloader, etc.) — ClipForge does not auto-download YouTube videos.
          </Callout>
        </Step>
        <Step n={4} title="Click “Render MP4 (9:16)”">
          The render process runs in 4 stages, with a live progress bar:
          <ul className="mt-1.5 ml-3 list-disc space-y-0.5">
            <li><b>Extract</b> — pulls the keep-ranges (between cuts) from your video</li>
            <li><b>Concat</b> — joins the kept segments back together</li>
            <li><b>Encode</b> — burns subtitles, applies zoompan, crops to 1080×1920, re-encodes H.264 + AAC</li>
            <li><b>Done</b> — renders an MP4 ready to download</li>
          </ul>
        </Step>
        <Step n={5} title="Preview & download">
          The rendered video appears in a player. Use <Play className="inline h-3 w-3" /> to preview, or click <span className="font-medium">Download MP4</span> to save the 9:16 vertical clip — ready to upload to Shorts/Reels/TikTok.
        </Step>
      </div>
      <Callout type="info">
        Rendered files are stored on the server (Render history) — the oldest are auto-cleaned to stay under the storage cap, so download the ones you want to keep.
      </Callout>
    </div>
  )
}

function LocalRenderTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Local Render Script — render with ffmpeg on your computer</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Prefer to render locally? Download a runnable ffmpeg shell script generated from your edit plan. Works with or without yt-dlp.
      </p>
      <div className="mt-5">
        <Step n={1} title="Generate an edit plan">
          Click <span className="font-medium text-primary">AI plan</span> on any clip, then in the Edit Plan dialog click the <span className="font-medium">.sh</span> button to download the render script.
        </Step>
        <Step n={2} title="Make sure ffmpeg is installed">
          On macOS: <Code>brew install ffmpeg</Code>. On Linux: <Code>sudo apt install ffmpeg</Code>. On Windows: download from ffmpeg.org.
          Verify with:
        </Step>
        <Step n={3} title="(Optional) Install yt-dlp for auto-download">
          If you want the script to auto-download the YouTube source, install yt-dlp:
        </Step>
      </div>
      <CodeBlock lang="bash">{`# macOS
brew install yt-dlp

# Linux/macOS via pip
pip install yt-dlp

# verify
yt-dlp --version`}</CodeBlock>

      <div className="mt-4">
        <Step n={4} title="Run the script">
          The script auto-detects yt-dlp if installed and downloads the source for you. Otherwise it expects a local file.
        </Step>
      </div>
      <CodeBlock lang="bash">{`# Option A: auto-download via yt-dlp (if installed)
YOUTUBE_URL="https://youtube.com/watch?v=YOUR_VIDEO_ID" bash clipforge_My_Clip.sh

# Option B: use a local video file
INPUT=/path/to/source.mp4 bash clipforge_My_Clip.sh

# → outputs: clipforge_My_Clip.mp4 (1080×1920, 9:16)`}</CodeBlock>

      <div className="mt-4">
        <Step n={5} title="What the script does">
          The downloaded <Code>.sh</Code> file is a complete ffmpeg pipeline:
          <ul className="mt-1.5 ml-3 list-disc space-y-0.5">
            <li>Writes an <Code>.ass</Code> subtitle file with emphasis styling</li>
            <li>Extracts keep-ranges (between cuts) from the source</li>
            <li>Concatenates them back together</li>
            <li>Burns the subtitles, applies <Code>zoompan</Code> for camera punch-in</li>
            <li>Crops to 1080×1920 (9:16 vertical)</li>
            <li>Re-encodes H.264 + AAC</li>
            <li>Cleans up intermediates</li>
          </ul>
        </Step>
      </div>
      <Callout type="tip">
        You can also download the <Code>.ass</Code> subtitle file separately (for use with any video editor) or the <Code>.json</Code> recipe (for your own renderer).
      </Callout>
    </div>
  )
}

// ---- Language tutorial ----
function LanguageTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Subtitle language — make subtitles match your video</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        By default, ClipForge outputs English. If your video is in Bahasa Indonesia (or another language), force the subtitle language so the AI writes hooks, titles, and reasoning in that language.
      </p>
      <div className="mt-5">
        <Step n={1} title="Find the language selector">
          In the hero input row, there&apos;s a <span className="font-medium text-cyan-500">🌐 Subtitle lang</span> dropdown next to the Editing style selector. Click it.
        </Step>
        <Step n={2} title="Pick the language">
          Choose from <span className="font-medium">18 languages</span>:
          <span className="mt-1.5 inline-flex flex-wrap gap-1">
            {['🌐 Auto', '🇬🇧 English', '🇮🇩 Bahasa Indonesia', '🇪🇸 Español', '🇧🇷 Português', '🇫🇷 Français', '🇩🇪 Deutsch', '🇮🇹 Italiano', '🇯🇵 日本語', '🇰🇷 한국어', '🇨🇳 中文', '🇸🇦 العربية', '🇮🇳 हिन्दी', '🇹🇭 ไทย', '🇻🇳 Tiếng Việt', '🇲🇾 Bahasa Melayu', '🇳🇱 Nederlands', '🇷🇺 Русский'].map((l, i) => (
              <span key={i} className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{l}</span>
            ))}
          </span>
        </Step>
        <Step n={3} title="Auto-detect mode (default)">
          With <span className="font-medium">🌐 Auto-detect</span>, the AI matches the source video language exactly. If the video title is in Bahasa Indonesia, all output (titles, hooks, reasons, analysis) will be in Bahasa Indonesia. The spoken <Code>hook</Code> field is transcribed as-is from the source.
        </Step>
        <Step n={4} title="Force a specific language">
          Select a specific language (e.g., 🇮🇩 Bahasa Indonesia) to force the AI to write titles, reasons, and analysis in that language — even if the source is different. The <Code>subtitle</Code> text fields are still transcribed faithfully from the source video (not translated); only metadata fields (purpose, reason, generated_hook) are written in the chosen language.
        </Step>
        <Step n={5} title="Analyze + generate plan">
          The language setting applies to both the analyze step (clip candidates) and the edit plan generation (subtitles, segments, camera reasons, etc.).
        </Step>
      </div>
      <Callout type="tip">
        For a video in Bahasa Indonesia: pick <Code>🇮🇩 Bahasa Indonesia</Code>. The AI will generate titles like &quot;Cara Belajar AI dengan Cepat&quot; and hooks in Indonesian — no more English mismatch.
      </Callout>
      <Callout type="info">
        The language preference persists for re-analyze. When you click <Code>Re-analyze</Code>, it uses the same language.
      </Callout>
    </div>
  )
}

// ---- VOD stream tutorial ----
function VODTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Clip a stream VOD — finished live streams & podcasts</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        ClipForge works with any video that has a YouTube URL — including VODs (Video on Demand) of finished live streams, podcasts, and 24/7 streams.
      </p>
      <div className="mt-5">
        <Step n={1} title="Get the VOD URL">
          After a live stream ends on YouTube, it becomes a regular video. Copy its URL:
          <CodeBlock lang="example">{`https://www.youtube.com/watch?v=VIDEO_ID   ← finished live stream
https://youtu.be/VIDEO_ID                  ← short URL
https://www.youtube.com/live/VIDEO_ID      ← YouTube Live VOD`}</CodeBlock>
        </Step>
        <Step n={2} title="Paste it into ClipForge">
          Drop the URL into the hero input box, pick your platform/style/language, and click <span className="font-medium text-primary">Auto-Clip</span>. ClipForge fetches metadata via oEmbed and analyzes the content.
        </Step>
        <Step n={3} title="What works">
          <ul className="ml-3 list-disc space-y-0.5">
            <li><b>Finished YouTube Live streams</b> — once the stream ends, it becomes a VOD you can clip</li>
            <li><b>24/7 streams</b> (lofi, radio) — the URL acts as a regular video</li>
            <li><b>Podcast episodes</b> uploaded to YouTube</li>
            <li><b>Twitch VODs</b> — paste the Twitch VOD URL (CliffForge handles it like a YouTube video)</li>
            <li><b>Recorded Zoom / Google Meet sessions</b> uploaded to YouTube</li>
          </ul>
        </Step>
        <Step n={4} title="What does NOT work (live streams in progress)">
          A stream that is <b>currently live</b> cannot be clipped on-demand because there&apos;s no video file yet. You need to wait for it to end and become a VOD.
          <Callout type="warn">
            If the URL returns a metadata error, the stream is still live or not yet uploaded as a VOD. Wait until it ends and YouTube processes it.
          </Callout>
        </Step>
        <Step n={5} title="Render the clip">
          Once you have a clip you like, generate an AI edit plan, then either:
          <ul className="ml-3 list-disc space-y-0.5">
            <li>Download a <Code>.sh</Code> render script with optional yt-dlp auto-download</li>
            <li>Upload your own downloaded video to the Render tab for server-side rendering</li>
          </ul>
        </Step>
      </div>
      <Callout type="tip">
        For 24/7 streams like Lofi Girl, paste the URL — ClipForge treats it like any long video and will find highlight clips based on its content analysis.
      </Callout>
    </div>
  )
}

// ---- Remotion editor tutorial ----
function RemotionTutorial() {
  return (
    <div>
      <h3 className="text-lg font-bold">Remotion Editor — interactive React-based video preview</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The Remotion Editor renders your edit plan as a real React video composition. Scrub the timeline, and all effects (subtitles, camera zoom, segment badges, visual cards) update live as React components.
      </p>
      <div className="mt-5">
        <Step n={1} title="Generate an edit plan">
          On any clip card, click <span className="font-medium text-primary">AI plan</span>. The plan must exist before you can open the Remotion Editor.
        </Step>
        <Step n={2} title="Open the Remotion Editor">
          In the Edit Plan dialog footer, click <span className="font-medium text-fuchsia-500">🎬 Remotion Editor</span>. The dialog closes and a full-screen Remotion Player opens.
        </Step>
        <Step n={3} title="The player shows the edit plan as a 9:16 composition">
          The composition renders at <Code>1080×1920</Code> (9:16 vertical). It embeds the YouTube video, applies the camera punch-in scale, overlays the segment badge, shows the generated hook as a title card (first 3s), burns subtitles with emphasis styling, and shows visual prompt cards at the right timestamps.
        </Step>
        <Step n={4} title="Interact with the timeline">
          <ul className="ml-3 list-disc space-y-0.5">
            <li><b>Play/Pause</b> — start or pause playback</li>
            <li><b>Restart</b> — jump back to frame 0</li>
            <li><b>Scrub the player&apos;s timeline</b> — drag the timeline under the video to jump to any frame; all overlays update instantly as React re-renders</li>
            <li><b>Side panel</b> — shows live segments, subtitles, and camera moves with the currently-active one highlighted as you scrub</li>
          </ul>
        </Step>
        <Step n={5} title="Why Remotion is more interactive">
          Unlike the Auto-Edit Preview (which drives the YouTube iframe), Remotion renders each frame as React components — so subtitle text, segment colors, camera scale, and visual cards are all <b>precise and frame-accurate</b>. You can scrub backward and forward without re-seeking the YouTube video.
        </Step>
      </div>
      <Callout type="info">
        The Remotion Player runs entirely in your browser — no server rendering needed. The composition code is React, so you can extend it with custom overlays, animations, or even export to a real MP4 using <Code>@remotion/renderer</Code> in a Node.js script.
      </Callout>
      <Callout type="tip">
        Use the side panel to verify your edit plan visually. If a segment, subtitle, or camera move is wrong, close the editor, edit the plan in the Edit Plan dialog, then reopen the Remotion Editor to see the changes.
      </Callout>
    </div>
  )
}

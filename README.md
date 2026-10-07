# ✂️ ClipForge AI — Transcript-Grounded Video Clipping Pipeline

> Paste a YouTube link → resolve **real duration** (yt-dlp → innertube → oEmbed, never guessed) → acquire **real transcript** (YouTube captions via yt-dlp, manual paste, or ASR for uploads) → the LLM proposes clip candidates **grounded in the transcript** → the server validates timestamps, recalculates scores, checks context, dedupes and ranks → generate a transcript-locked **Edit Plan** → render a real **1080×1920 H.264+AAC MP4** with frame-accurate cuts, burned subtitles (output-time mapped) and camera punch-ins → export **JSON / SRT / VTT / CSV / EDL**.

Built with **Next.js 16**, **TypeScript**, **Tailwind CSS 4**, **shadcn/ui**, **Prisma + SQLite**, an **ffmpeg renderer micro-service**, and the **z-ai-web-dev-sdk** LLM.

**Honesty guarantees** (enforced in code, not just docs):
- ClipForge **never guesses video duration**. If yt-dlp/innertube can't provide it, you must enter it manually (`durationSource` is persisted and displayed).
- ClipForge **never invents spoken quotes**. Every `spokenHook` is verified against the transcript; unverified hooks are dropped or flagged. Without a transcript, `hookVerified=false` and hooks are omitted.
- Subtitles come **only from the transcript**. AI-proposed subtitle text is verified; on mismatch the server rebuilds subtitles deterministically from word timestamps.
- The **server** calculates total scores and POST/SKIP. The LLM's own totals are ignored.
- The renderer applies exactly: **cuts, subtitle burn-in, camera punch-in, 9:16 crop, H.264+AAC encode**. B-roll/visuals/animations/SFX/music are clearly labeled **preview-only recommendations** (export the JSON plan to apply them in a real editor).

---

## Pipeline

```
YouTube URL
  → POST /api/youtube/meta            real metadata; duration via yt-dlp → innertube → oEmbed (or null + manual required)
  → POST /api/source/prepare          async job (PRIMARY UI PATH): DOWNLOADING → TRANSCRIBING → COMPLETED
                                      • resolves real metadata + fetches YouTube captions automatically
                                      • prefers the word-offset ASR track ('orig') → wordTiming 'measured'
                                      • persists duration + transcript + word timestamps into an owned Project
                                      • failed jobs are retryable: POST /api/jobs/:id/retry (payload persisted)
  → POST /api/clips/analyze           transcript-grounded candidate detection
                                      • belt-and-braces: auto-fetches captions here too when none supplied
        • Zod-validated AI output (+1 repair attempt)
        • hard timestamp clamps + word-timestamp snapping
        • context validation → PASS / EXTEND / REJECT / UNKNOWN
        • server-side weighted scoring (0-100) + POST/SKIP
        • dedupe (overlap + semantic) → rank → enforce requested count
        • transactional persistence + analysis metadata (model/provider/promptVersion/analysisVersion)
  → POST /api/clips/plan              transcript-locked edit plan (subtitles verified against transcript; deterministic rebuild on mismatch)
  → POST /api/render-proxy/render     ffmpeg renderer (job-based, SSE progress, ffmpeg -progress granular stages): frame-accurate trim+concat → ASS burn-in → zoompan → 1080×1920
  → POST /api/export                  json (full plan + transcript + scores) · srt · vtt (real speech, output time) · csv · edl
```

**Zero-input auto-grounding:** pasting a URL and hitting Auto-Clip runs the prepare job first — captions (with real word timestamps when the ASR track exists) are fetched automatically, so hooks are verbatim-verified with no manual paste. Availability is environment-dependent; degradation stays honest (`transcriptSource: 'none'`).

## Security model
- Anonymous **session ownership**: every visitor gets an httpOnly `clipforge_sid` cookie; every `Project` row stores `ownerId`.
- **Every** API operation (projects CRUD, clips CRUD, export, analyze, plan, jobs) is scoped by `ownerId` — another user's ID returns `404`.
- `GET /api/clips` **requires** `projectId` and returns only that owned project's clips.
- Rate limiting on all expensive endpoints: analyze (10/min), plan (20/min), meta (30/min), prepare (10/min), render (6/min), export (30/min).
- In-memory rate limiting suits single-instance dev; for multi-instance production use a shared store (Redis / Postgres) — see "Production notes".

## The renderer (mini-services/ffmpeg-renderer, port 3003)
- `POST /render` (multipart: video + recipe JSON) → job id
- `GET /jobs/:id` · `GET /jobs/:id/stream` (SSE) · `GET /jobs/:id/download`
- Frame-accurate: `filter_complex trim/atrim + concat` (NOT `-c copy`, which snaps to keyframes and desynchronizes duration)
- Subtitle burn-in via `ass` filter — all event times converted **SOURCE_TIME → OUTPUT_TIME** (cuts removed), cut-covered events dropped, canonical `H:MM:SS.cc` ASS timestamps (libass misparses other formats)
- Camera punch-in via `zoompan` with **output-time keyframes** (pre-mapped through the cut-removal inverse)
- Output probed after render: must be H.264 + AAC, dimensions recorded

## API surface
| Endpoint | Purpose |
|---|---|
| `POST /api/youtube/meta` | Real metadata resolution (`durationSource` honest) |
| `POST /api/source/prepare` | Async job: real duration + transcript acquisition |
| `GET /api/jobs/:id` | Job status (owner-scoped) |
| `POST /api/clips/analyze` | Transcript-grounded analysis (full validation pipeline) |
| `POST /api/clips/plan` | Transcript-locked edit plan |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | Owned projects |
| `GET/POST /api/clips`, `GET/PATCH/DELETE /api/clips/:id` | Owned clips (transactional bulk replace) |
| `POST /api/export` | json / srt / vtt / csv / edl |
| `POST /api/render/script` | ffmpeg shell script / ASS / recipe JSON download |
| `POST /api/render-proxy/*` | Proxy to the renderer micro-service |

## Environment variables / binaries
- `DATABASE_URL` (SQLite file) — see `.env`
- Server needs **ffmpeg**, **ffprobe**, and optionally **yt-dlp** (searched in PATH, `/home/z/.venv/bin`, `/usr/local/bin`, `/usr/bin`)
- yt-dlp benefits from a JS runtime (bun) for YouTube extraction

## Known environment constraint
YouTube heavily rate-limits/bot-blocks datacenter IPs (player API returns "Sign in to confirm you're not a bot"). On such hosts:
- duration resolution degrades to oEmbed (title/author only) → `duration: null` + `requiresManualDuration: true` → the UI asks you to enter the real duration
- caption download fails → `transcriptSource: 'none'` → analysis runs ungrounded (hooks omitted, `contextRisk=true`) or you paste a transcript manually
No fake values are substituted — this is by design.

## Tests
```bash
bun run tests/clipforge-unit.ts   # 73 assertions: scoring scale, hook grounding, dedupe/overlap/count,
                                  # timeline mapping (incl. totalCutDuration/outputDuration semantics),
                                  # bounded mapping, drop-by-cuts rule, measured-vs-estimated word timing,
                                  # clamps, context validation, JSON extraction, SRT/VTT
bun run tests/e2e-render.ts       # GOLDEN E2E: synthetic fixture → plan → recipe → real FFmpeg render →
                                  # ffprobe/volumedetect assertions (duration, 1080x1920, h264+aac, non-silent audio)
bash tests/clipforge-live.sh      # live API tests: duration honesty, transcript grounding, security, duplicate save, exports
```

## Production notes
- Swap SQLite → PostgreSQL (Prisma datasource change; schema is portable) for multi-user deployments — full migration map in `docs/SAAS-MIGRATION.md`.
- Replace in-memory rate limiting with Redis (or Postgres-backed) shared store when running >1 instance.
- The async job store (`SourceJob`) is already DB-backed; a dedicated queue worker (BullMQ etc.) can be added without API changes.
- ASR for uploaded files: run faster-whisper server-side and feed `words` into the analyze/plan endpoints (schema already supports word-level timestamps end-to-end).
- Word-timestamp provenance is tracked (`wordTiming: 'measured' | 'estimated'`): json3/srv3 caption offsets and faster-whisper produce MEASURED timing; VTT-only sources and manual pastes are labeled honestly in the UI.

## Status: **MVP+ (beta)** — the full pipeline (URL or upload → real duration → transcript with word timestamps → grounded AI analysis → server scoring → plan → frame-accurate render) is real and verified end-to-end, now with zero-input auto-grounding (YouTube captions fetched automatically when available, with retryable source-prep jobs and usage metering). Remaining gaps: YouTube metadata/captions depend on the host IP not being bot-blocked (manual-duration + ASR-upload flows are first-class, failed prepares are retryable), and B-roll/SFX/music remain preview-only recommendations.

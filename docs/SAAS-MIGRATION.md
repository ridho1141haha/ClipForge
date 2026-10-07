# ClipForge — SaaS Migration Notes

> Status: **documentation only** — nothing here is implemented yet, by design.
> Principle: *build the product engine now; make the architecture SaaS-migratable, not SaaS-heavy.*

This document records every place that must change when ClipForge grows from a
personal tool (anonymous session, single instance, local disk) into a public
multi-tenant product. Each section lists: the current seam, the migration
target, and the blast radius, so future work can be planned without
archaeology.

---

## 1. Authentication
- **Now**: anonymous httpOnly cookie session (`src/lib/session.ts`,
  `getOrCreateSessionId()`). Every DB row hangs off `ownerId = session id`.
- **Later**: real accounts (email/Google OAuth). Recommended bridge: keep the
  `ownerId` column, backfill sessions into a `User` table, make
  `Project.ownerId → User.id`. No core-engine change required because **all
  ownership checks already funnel through `ownerId` comparisons**.
- **Blast radius**: `src/lib/session.ts` only (+ auth UI).

## 2. Ownership → Workspaces
- **Now**: `ownerId` on `Project`; `Clip` reachable only through an owned
  `Project` (cascade). Every route verifies `ownerId` before touching data.
- **Later**: `Workspace (id) ← membership(User, role)` and
  `Project.workspaceId`. Introduce `principalId = workspace ?? user` as the
  ownership key instead of adding per-route checks.
- **Blast radius**: schema + one shared `assertCanRead/Write(principal, project)`
  helper (the checks are already centralized per route).
- **Rule kept today**: business logic never assumes `ownerId` is a permanent
  account — it is an opaque string key.

## 3. Database (SQLite → Postgres)
- **Now**: SQLite via Prisma (`db/custom.db`), one process, WAL not enabled.
- **Later**: Postgres (`DATABASE_URL` swap + `prisma migrate`). Prisma schema
  is already portable (no SQLite-only types; `Float`/`String`/`Int`/`DateTime`
  only).
- **Watch-outs**: transactions that currently rely on SQLite serialization
  (`db.$transaction` in analyze/save paths) are fine on Postgres; add row
  locks (`SELECT … FOR UPDATE`) only if concurrent edits to the same project
  appear. JSON-in-string columns (`transcriptWords`, `scores`, `analysisMeta`,
  `result`) → `Json` columns or side tables when queryable.
- **Prepared**: analysis reproducibility metadata already stored
  (`analysisMeta`: model/provider/promptVersion/analysisVersion/wordTiming).

## 4. Storage (local disk → object storage)
- **Now**: three narrow filesystem seams:
  1. uploaded ASR media — written by `/api/source/transcribe`, deleted after
     transcription;
  2. render inputs/outputs — `mini-services/ffmpeg-renderer` `WORKDIR`
     (`upload/ffmpeg-render/<jobId>/`), outputs auto-expire after 10 min;
  3. `db/` SQLite file.
- **Later**: introduce a light `AssetRef` seam **when** a second storage
  backend actually exists:
  ```ts
  type AssetRef = {
    id: string
    type: 'source' | 'render' | 'thumbnail' | 'proxy'
    location: string        // s3://… | file:///…
    mimeType?: string
    sizeBytes?: number
    expiresAt?: string      // renders expire; sources persist
  }
  ```
  Renderer contract impact: the recipe gains `input: AssetRef` and the job
  result gains `output: AssetRef` — the recipe→renderer interface otherwise
  unchanged.
- **Deliberate decision**: no AssetRef abstraction was added *now* — there is
  only one backend (local disk) and the seams are already narrow (single
  WORKDIR constant per service). Adding it would be ceremony, not function.

## 5. Jobs (in-process → persistent queue)
- **Now**:
  - `SourceJob` table (QUEUED / DOWNLOADING / TRANSCRIBING / COMPLETED /
    FAILED + `errorCode`) persists source-prep and ASR state;
  - render jobs live in the renderer mini-service memory
    (queued → extracting → rendering → finalizing → done / error / **cancelled**),
    with SSE progress + polling; outputs expire in 10 min.
- **Later**: durable queue (Postgres-backed table is enough at first — no
  Redis required) with `Job { id, type, payload, state, attempt, lastError }`
  and idempotent stages. Stage results should be checkpointed so a retry does
  not redo completed stages:
  - source prep: metadata ✓ → captions ✓ → persist ✓ (already sequential and
    idempotent per stage — reuse cached `Project` fields);
  - render: download input → encode → upload artifact (encode is the only
    expensive step; checkpoint = stored artifact).
- **Boundary already respected**: the Next.js API never runs ffmpeg in-process;
  it only talks to the renderer over HTTP.

## 6. Renderer (local mini-service → scalable render workers)
- **Now**: `mini-services/ffmpeg-renderer` (Bun, port 3003), single-threaded
  per job, frame-accurate `trim/atrim+concat` single pass, verifies codec +
  resolution + duration of its own output, supports cancel.
- **Later**: run N copies behind a queue. Because of the RenderRecipe contract
  (see the header of `src/lib/render-recipe.ts`), a new worker only needs to
  implement **recipe JSON + input file → MP4**. Nothing in the editor, plan,
  or export code changes.
- **Keep**: `durationOk`/codec/resolution self-check — it is the renderer's
  honesty gate; make it mandatory in any reimplementation.

## 7. Billing / Subscription
- **Now**: none. No entitlement logic anywhere (correctly avoided).
- **Later**: `Plan`, `Subscription`, `Entitlement` tables; enforcement points
  are already identifiable:
  - `/api/clips/analyze` (analysis minutes / clips per month)
  - `/api/source/transcribe` (ASR minutes)
  - `/api/render-proxy` POST (render minutes)
  - `/api/export` (downloads)
  All four are the only expensive surfaces and are already rate-limited —
  entitlement checks slot into the same positions.

## 8. Usage metering
- **Now**: nothing persisted.
- **Later**: `UsageEvent { principalId, kind: 'transcribe'|'render'|'analyze', seconds, jobId, createdAt }`
  written at job completion. Renderer already reports real output duration
  (`job.duration`), transcribe reports ffprobe duration — the numbers to meter
  already exist.

## 9. Observability
- **Now**: structured-ish console logs; renderer logs per job; rate-limit
  store in memory; no metrics.
- **Later**: request/job ID correlation, error tracking (Sentry-class), metrics
  for job durations + failures per stage, and a shared rate-limit store
  (Postgres table or Redis) — the in-memory `checkRateLimit` is per-instance
  and resets on deploy (documented in `src/lib/validation.ts`).

## 10. Security checklist for public deployment
Already true today (keep it true):
- ownership enforced on every project/clip/analyze/export route (404 on foreign ids)
- AI output Zod-validated; LLM totals/recommendations never trusted
- YouTube URL validated; duration never faked; transcript never fabricated
- renderer filenames sanitized (`[a-z0-9-_]`, 60 chars) — no path traversal
- shell-script generator interpolates only sanitized identifiers
- user-controlled timestamps clamped before any ffmpeg use

Add later: real auth (§1), per-principal rate limits (§9), signed asset URLs
(§4), request body size limits at the edge, CSRF review on cookie-session
mutations.

---

### Migration order that made sense to write down
1. Accounts (§1) → 2. Postgres (§3) → 3. object storage + AssetRef (§4) →
4. durable queue (§5) → 5. render workers (§6) → 6. billing + usage (§7–8).
Each step is independent; none requires rewriting the core engine.

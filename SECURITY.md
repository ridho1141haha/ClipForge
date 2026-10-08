# ClipForge — Security Policy

## Supported scope

ClipForge is a local-first video repurposing engine (single instance, anonymous
session ownership). This document summarizes the actual security architecture —
claims here are backed by tests (see `tests/clipforge-unit.ts`,
`tests/render-security-e2e.ts`).

## Ownership model

- Every visitor gets an httpOnly session cookie (`clipforge_sid`).
- **Projects, Clips, SourceJobs, UsageEvents and RenderJobs are all scoped by
  `ownerId`.** All API queries filter `WHERE id = X AND ownerId = session`.
- Render-job authorization is enforced at the public proxy
  (`/api/render-proxy/*`): poll / SSE stream / cancel / download all verify the
  `(jobId, ownerId)` pair in the `RenderJob` table first. Random job-UUID
  secrecy is never relied on.
- The ffmpeg-renderer mini-service is **explicitly bound to `127.0.0.1`**
  (Bun's default would be `0.0.0.0`; the bind is set in code and asserted
  behaviorally by the render-security E2E). It also enforces **internal
  authentication**: every request must carry the shared secret
  (`X-ClipForge-Internal-Token: $CLIPFORGE_RENDERER_TOKEN`, checked with a
  constant-time comparison BEFORE routing, body parsing, job mutation, or any
  FFmpeg work). Loopback binding alone cannot stop a malicious local webpage
  from POSTing to `127.0.0.1:3003` — a simple cross-origin multipart POST
  needs no CORS preflight, so the browser sends it even though it cannot read
  the response. CORS is not authentication; the token is. The token lives
  only in server-side environments (`.env` / process env — never in browser
  JS, logs, or public API responses), and the renderer **fails closed**
  (exits at startup) when no token is configured.
  It emits **no CORS headers at all**: CORS is browser-enforced, its only
  supported client is the Next.js proxy (server-to-server fetch), and wildcard
  CORS would only ever authorize browser pages to read an internal service.
  The Next.js proxy is the single public authorization boundary:
  `Browser → Next.js authorization (session + ownership + internal token) →
  127.0.0.1 renderer → FFmpeg`
  (the proxy targets the literal loopback address — no `localhost` DNS drift).
  The proxy attaches the internal token to EVERY renderer call — render
  start, poll, SSE, cancel, download, cover, and the ownership-failure
  cancel — and fails closed with an honest 500 when the token is not
  configured on the Next.js side.

## Threat model & mitigations (implemented)

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Cross-owner project/clip/job access | `ownerId` scoping on every query; render jobs authorized in the proxy | render-security E2E (foreign poll/stream/cancel/download → 404), scale test |
| Unauthenticated drive-by access to the renderer (malicious local page POSTs to 127.0.0.1:3003) | Internal shared-secret auth (`CLIPFORGE_RENDERER_TOKEN`): missing/wrong token → 401 BEFORE routing, body parsing, job mutation, or FFmpeg; fail-closed startup; token never exposed client-side or logged | renderer-auth E2E (401 matrix on every endpoint, fail-closed startup test, authenticated happy path), render-security E2E (401 without/with-wrong token), unit structural scans |
| Malicious render recipe (NaN/Infinity, absurd durations, unbounded arrays) | Strict `validateRecipe()` in the renderer before any ffmpeg work; documented resource limits (`RECIPE_LIMITS`) | unit: validation rejection matrix; E2E: NaN → 400 |
| Full-cut phantom render | `buildKeepRanges()` returns `[]` for a fully-cut clip; renderer rejects empty output (`EMPTY_OUTPUT`) instead of falling back to the full clip | unit edge case I; render-security E2E |
| Filter-expression injection via recipe values | Numeric-only enforcement (e.g. camera `scale` must be a finite number in [0.5, 10]) — no strings reach ffmpeg filter strings | unit: string-scale rejection |
| Command injection | ffmpeg / ffprobe / yt-dlp invoked via `execFile`/`spawn` with argument arrays — no shell string concatenation anywhere | code audit |
| Path traversal (stored media paths) | `resolveLocalMediaPath()`: `upload/` prefix + containment check; YouTube ids validated by `isSafeYouTubeId` before path use | unit: traversal/absolute/non-upload/empty rejected |
| Oversized uploads / memory exhaustion | 1.5 GB source cap enforced BEFORE buffering (declared Content-Length precheck) AND during streaming (byte-capped TransformStream — covers chunked uploads that omit Content-Length, trips → honest 413); 1 MiB recipe cap; client multipart uploads are forwarded as STREAMS (never `req.blob()`/`req.arrayBuffer()`); server-side media is streamed into the renderer multipart with **consumer-driven backpressure** (`pull()`-based reads, memory bounded at ~2 chunks regardless of file size, `cancel()` releases the file handle); renderer artifacts (MP4/cover) are streamed from disk via `Bun.file` and piped through the proxy — a 500 MB render never materializes in server RAM | unit structural scans; render-security + golden + url-render E2E (real uploads/downloads through the proxy) |
| Render artifacts leaking across sessions | 10-minute artifact lifetime in the renderer; download requires ownership | render-security E2E |
| SSRF | All outbound calls target fixed hosts (YouTube APIs, localhost renderer); URLs built from validated YouTube ids only | code audit |
| Transcript timing fabrication | Word timing provenance is computed server-side: a missing caption offset stays ABSENT (never coerced to `0` = "measured"); multi-word caption segments never claim independent word timing; provenance labels (`measured`/`estimated`/`mixed`) are per-word and unit-tested | unit: timing-honesty + VTT fixture matrices |
| Rate abuse of expensive routes | In-memory rate limits on analyze / prepare / transcribe / render-start (documented: single-instance only) | validation.ts |
| Orphan renderer work after an ownership-recording failure | `recordRenderJob()` failure no longer swallows silently: the proxy cancels the renderer job and returns an honest 500 — the client never receives an id that every later operation would 404, and no render keeps burning CPU/disk without a DB owner | structural unit assertions; render-security E2E (ownership recording verified on the happy path; simulated-DB-failure live test intentionally NOT run against the shared dev database) |

## Known limitations (honest)

- The rate-limit store is in-memory — appropriate for single-instance dev; a
  public multi-instance deployment needs a shared store (see
  `docs/SAAS-MIGRATION.md`).
- Sessions are anonymous cookies; there is no authentication yet. Ownership is
  per-browser-session, not per-identity.
- The renderer validates recipes strictly, authenticates every caller with the
  shared internal token, and is bound to loopback — but the token is a
  deployment-wide shared secret, not per-user identity. Anyone with
  server-side file/env access can read it (that trust level is inherent to
  single-instance local-first deployments).
- Cancellation is race-hardened: a job cancelled during finalization can never
  be finalized as `done` (guarded state transition, unit-asserted), and every
  terminal outcome (done/error/cancelled) schedules job-dir cleanup — no disk
  leak from cancelled renders.

## Reporting

Open a GitHub issue with the `security` label. For this personal/local project
there is no private disclosure channel; do not include secrets in issues.

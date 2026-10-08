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
  (Bun's default would be `0.0.0.0`; the bind is set in code and covered by a
  structural test). It performs NO authorization of its own — it is a trusted
  internal service reachable only from the local machine. The Next.js proxy is
  the single public authorization boundary:
  `Browser → Next.js authorization → localhost renderer → FFmpeg`.
  A remote-renderer deployment would require explicit internal authentication
  on both sides first (documented in the renderer source header).

## Threat model & mitigations (implemented)

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Cross-owner project/clip/job access | `ownerId` scoping on every query; render jobs authorized in the proxy | render-security E2E (foreign poll/stream/cancel/download → 404), scale test |
| Malicious render recipe (NaN/Infinity, absurd durations, unbounded arrays) | Strict `validateRecipe()` in the renderer before any ffmpeg work; documented resource limits (`RECIPE_LIMITS`) | unit: validation rejection matrix; E2E: NaN → 400 |
| Full-cut phantom render | `buildKeepRanges()` returns `[]` for a fully-cut clip; renderer rejects empty output (`EMPTY_OUTPUT`) instead of falling back to the full clip | unit edge case I; render-security E2E |
| Filter-expression injection via recipe values | Numeric-only enforcement (e.g. camera `scale` must be a finite number in [0.5, 10]) — no strings reach ffmpeg filter strings | unit: string-scale rejection |
| Command injection | ffmpeg / ffprobe / yt-dlp invoked via `execFile`/`spawn` with argument arrays — no shell string concatenation anywhere | code audit |
| Path traversal (stored media paths) | `resolveLocalMediaPath()`: `upload/` prefix + containment check; YouTube ids validated by `isSafeYouTubeId` before path use | unit: traversal/absolute/non-upload/empty rejected |
| Oversized uploads / memory exhaustion | 1.5 GB source cap enforced BEFORE buffering (declared Content-Length precheck) AND during streaming (byte-capped TransformStream — covers chunked uploads that omit Content-Length, trips → honest 413); 1 MiB recipe cap; client multipart uploads are forwarded as STREAMS (never `req.blob()`/`req.arrayBuffer()`); renderer artifacts (MP4/cover) are streamed from disk via `Bun.file` and piped through the proxy — a 500 MB render never materializes in server RAM | unit structural scans; render-security + golden E2E (real uploads/downloads through the proxy) |
| Render artifacts leaking across sessions | 10-minute artifact lifetime in the renderer; download requires ownership | render-security E2E |
| SSRF | All outbound calls target fixed hosts (YouTube APIs, localhost renderer); URLs built from validated YouTube ids only | code audit |
| Transcript timing fabrication | Word timing provenance is computed server-side: a missing caption offset stays ABSENT (never coerced to `0` = "measured"); multi-word caption segments never claim independent word timing; provenance labels (`measured`/`estimated`/`mixed`) are per-word and unit-tested | unit: timing-honesty + VTT fixture matrices |
| Rate abuse of expensive routes | In-memory rate limits on analyze / prepare / transcribe / render-start (documented: single-instance only) | validation.ts |

## Known limitations (honest)

- The rate-limit store is in-memory — appropriate for single-instance dev; a
  public multi-instance deployment needs a shared store (see
  `docs/SAAS-MIGRATION.md`).
- Sessions are anonymous cookies; there is no authentication yet. Ownership is
  per-browser-session, not per-identity.
- The renderer trusts the localhost network zone; it validates recipes strictly
  but performs no per-caller authentication (it is not reachable from outside).
- Cancellation is race-hardened: a job cancelled during finalization can never
  be finalized as `done` (guarded state transition, unit-asserted), and every
  terminal outcome (done/error/cancelled) schedules job-dir cleanup — no disk
  leak from cancelled renders.

## Reporting

Open a GitHub issue with the `security` label. For this personal/local project
there is no private disclosure channel; do not include secrets in issues.

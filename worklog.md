# ClipForge Worklog

---
Task ID: 0
Agent: Z.ai Code (senior engineer)
Task: Phase 0 — Full repository audit of github.com/ridho1141haha/ClipForge; compare source code vs README/worklog claims; produce implementation gap report.

Work Log:
- Cloned repo to /home/z/clipforge-audit (HEAD a5cb41d "docs: update worklog with P0/P1 audit fix assessment").
- Read every API route, lib module, prisma schema, mini-service, and key UI components. Traced each utility function to see whether it is actually called from a real request path.
- Probed sandbox capabilities: ffmpeg 7.1.5 ✅, ffprobe ✅, python 3.12 ✅, yt-dlp 2026.08.19 installed ✅. YouTube player data-plane (innertube WEB/ANDROID/IOS/TVHTML5, watch page, yt-dlp) is **bot-blocked from this sandbox IP** ("Sign in to confirm you're not a bot"). Only oEmbed (title/author/thumbnail, NO duration) works. HuggingFace/PyPI reachable.

## PHASE 0 — IMPLEMENTATION GAP REPORT (source of truth = code, not worklog.md)

### Actually wired & working (verified by call-path trace)
1. Analyze route calls `AnalyzeResponseSchema.safeParse` after JSON extraction ✅
2. `clampClipTimes`, `dedupeAndRank` (overlap+count), `recalcTotal`, `determineRecommendation`, `validateHookAgainstTranscript` are called in the analyze path ✅ (but see bugs below)
3. ffmpeg-renderer mini-service (port 3003) with job queue/SSE/download + Next proxy route ✅
4. Render script generator (/api/render/script) produces working ffmpeg pipeline ✅

### GAPS — documented as "fixed" (worklog/README) but NOT wired or broken
| # | Severity | Finding |
|---|----------|---------|
| 1 | P0 | **Fake duration**: `/api/youtube/meta` uses `estimateDuration(title)` — title-keyword heuristics → 720/900/3600/60s. yt-dlp/YouTube API never used. `durationSource: 'estimated'` hardcoded in export JSON. Analyze silently falls back to `720`. Violates Phase 1. |
| 2 | P0 | **No transcript pipeline**: transcript only enters via manual paste textarea. `Project.transcript` column exists but is NEVER written by any code path. No captions fetch, no ASR, no word timestamps. Violates Phase 2. |
| 3 | P0 | **Score scale bug**: `recalcTotal()` returns 0–10 (weights sum 1.0 × dims 0–10) but `determineRecommendation` requires `total >= 60` → **every clip is always SKIP**. UI color thresholds (85/70/50) also mismatch. |
| 4 | P0 | **Plan API not transcript-grounded**: `PlanBody` has NO transcript/word fields; AI invents subtitle text from title/hook. `EditPlanSchema` exists in validation.ts but is **never used** by the plan route (hand-rolled clamping instead). Violates Phases 4 & 9. |
| 5 | P0 | **Zero security**: `getOrCreateSessionId()` defined in validation.ts but **never called anywhere**. No ownerId. `GET /api/projects` returns all users' projects; `GET /api/clips` returns ALL clips in DB; project/clip/export endpoints unscoped → cross-user access by ID guessing. Violates Phase 10. |
| 6 | P0 | **Broken transaction**: bulk save does `deleteMany` OUTSIDE `$transaction` → creation failure loses all old clips. Single-create uses `increment` (inconsistent with bulk recalc). Violates Phase 12. |
| 7 | P0 | **Timeline mapping dead code**: `sourceToOutputTime`, `sourceToOutputTimeV2`, `buildCutRemovalMap` are **never called**. `generateASS` uses naive `start - clipStart` → subtitles desync after cuts. `buildZoompanFilter` maps output frames to SOURCE time assuming no cuts → camera moves desync. Violates Phase 13. |
| 8 | P1 | **SRT export is fabricated**: `format === 'srt'` emits one block per clip containing clip TITLE + hook — not spoken content. No VTT export at all. Violates Phases 15/17. |
| 9 | P1 | **Rate limiting only on analyze**: meta, plan, export, render-proxy, prepare unprotected. Violates Phase 11. |
| 10 | P1 | **No context validation**: PASS/EXTEND/REJECT absent; only the AI's own `context_risk` flag is trusted. Violates Phase 7. |
| 11 | P1 | **No semantic dedupe** (only overlap); no server-side guarantee analysis for clipCount beyond truncation. Phase 8 partial. |
| 12 | P1 | **No analysis metadata** (model/provider/promptVersion/analysisVersion) stored → results not reproducible. No PostgreSQL prep. Violates Phase 18. |
| 13 | P1 | **No async job pipeline** for download/transcribe (analyze is one synchronous HTTP request; no DOWNLOADING/TRANSCRIBING states). Violates Phase 19 (render is already job-based ✅). |
| 14 | P2 | Renderer race: global `recipe_duration` shared across concurrent jobs. Extract uses `-c copy` (keyframe-inaccurate). |
| 15 | P2 | Renderer renders only cuts/subs/zoom/crop; B-roll/SFX/music/animations are NOT rendered and not clearly labeled preview-only in upload UI. |
| 16 | P2 | `spokenHook` vs `generatedHook` separation incomplete (analyze returns only `hook`; plan has `generated_hook`). |
| 17 | P2 | No face tracking anywhere (README doesn't claim it — OK, must stay that way). |

### Verdict
System as-of-clone = **demo with metadata-based AI guesses** + partial P0 patch layer (scoring wired but scale-broken). MVP-not-honest.

Stage Summary:
- Gap report above is the contract for Phases 1–20 implementation in /home/z/my-project.
- Environment constraint recorded: YouTube player endpoints IP-blocked in sandbox → resolver chain must degrade explicitly (no fake values), manual duration/transcript flows are first-class.

---
Task ID: 1-9 (implementation)
Agent: Z.ai Code (senior engineer)
Task: Implement Phases 1-19 — real source data, transcript pipeline, grounded analyze/plan, server scoring, security, transactions, timeline correctness, real rendering, exports, jobs.

Work Log:
- Copied ClipForge source into /home/z/my-project (Next.js 16 app), installed remotion deps, pushed new Prisma schema.
- NEW prisma/schema.prisma: Project.ownerId (session ownership), duration Float + durationSource, transcript/transcriptWords/transcriptSource, analysisMeta (model/provider/promptVersion/analysisVersion); Clip.spokenHook/hookVerified/contextStatus/clipTranscript/clipWords; SourceJob table (QUEUED/DOWNLOADING/TRANSCRIBING/COMPLETED/FAILED + errorCode).
- NEW src/lib/session.ts: httpOnly cookie anonymous sessions (getOrCreateSessionId) — the previously-dead getOrCreateSessionId is replaced and USED by every route.
- NEW src/lib/media.ts: resolver chain yt-dlp(--js-runtimes bun) → innertube player API (ANDROID/WEB) → oEmbed. duration=null+durationSource='unavailable' when unobtainable (NEVER guessed). yt-dlp json3/vtt caption parsing → word-level timestamps. ffprobe local duration.
- NEW src/lib/subtitles.ts: canonical SOURCE_TIME↔OUTPUT_TIME mapping (buildKeepRanges, sourceToOutputTime, outputToSourceTime), word grouping, buildSubtitlesFromWords, SRT/VTT builders.
- REWRITTEN src/lib/validation.ts: FIXED recalcTotal scale bug (now ×10 → 0-100; previously 0-10 which made every clip SKIP), Zod AnalyzeResponseSchema + EditPlanSchema, extractJsonObject (balanced-brace extraction; validation still Zod-only), validateHookAgainstTranscript (empty transcript = NOT verified), checkContext (PASS/EXTEND/REJECT w/ backward+forward extension), dedupeAndRank (+semantic dedupe via title/excerpt similarity), rate limiting w/ sweep + headers.
- REWRITTEN /api/clips/analyze: requires REAL duration (400 otherwise, no 720 fallback), transcript+words in prompt with grounding rules (verbatim spoken_hook, no fabrication, fewer clips allowed), Zod validation + 1 repair attempt, server-side clamps/word-snapping/context validation/score caps (unverified hook caps hook≤4, ctx≤5)/recalcTotal/determineRecommendation/dedupeAndRank(count enforced), transactional persistence + analysisMeta, returns spokenHook/hookVerified/contextStatus.
- REWRITTEN /api/clips/plan: requires real videoDuration, receives clipTranscript+clipWords, subtitles transcript-LOCKED (AI text verified against transcript; >34% mismatch → deterministic rebuild from word timestamps), EditPlanSchema.safeParse, cuts clamped/merged/capped (40%), persists plan.
- REWRITTEN /api/youtube/meta: real duration chain, requiresManualDuration flag, rate limited.
- NEW /api/source/prepare + /api/jobs/[id]: async job pipeline (Phase 19) with DOWNLOADING/TRANSCRIBING states, persists real metadata+transcript to owned project.
- REWRITTEN /api/projects, /api/projects/[id], /api/clips, /api/clips/[id]: ALL owner-scoped (404 on foreign ids); GET /api/clips requires projectId + ownership; bulk save = ONE transaction (delete+create+count, Phase 12); single create recount in transaction.
- REWRITTEN /api/export: json (full plan incl. transcript, scores, contextStatus, keepRanges, analysisMeta, renderSettings, rendererCapabilities), srt/vtt from REAL transcript words (output-time; 422 when no transcript — never fabricates), csv+edl (edl now emits per-keep-range rows).
- REWRITTEN src/lib/render-recipe.ts: generateASS maps SOURCE→OUTPUT per subtitle + drops cut-covered events; buildZoompanFilter maps output frames → outputToSourceTime → scale; buildRecipeJSON emits output-time camera keyframes; script labels RENDERED vs PREVIEW-ONLY features.
- mini-services/ffmpeg-renderer/index.ts: fixed per-job recipeDuration race; zoompan uses pre-mapped OUTPUT-time keyframes.
- /api/render/script + /api/render-proxy: rate limited.
- Frontend wired: page.tsx (duration guard — refuses to analyze without real duration; sends projectId/transcript/words; maps spokenHook/hookVerified/contextStatus; plan flow sends clipTranscript+clipWords; save sends new fields; loadProject maps new fields, no 720 fallback), url-input (advanced panel copy honest about grounding), video-preview (durationSource badge + requiresManualDuration warning), clip-card (verified-in-transcript / unverified badges, ctx pass/extended badges), export-dialog (VTT + honest SRT note), upload-render (explicit RENDERED vs PREVIEW-ONLY capability panel).
- tests/clipforge-unit.ts: 48 assertions covering scoring scale, hook grounding, dedupe/count/overlap, timeline mapping (34→24 example), clamping, context validation, JSON extraction, SRT/VTT. ALL PASSING. Tests caught 1 real bug (sourceToOutputTime double-count) — fixed.

Stage Summary:
- Phases 1-19 implemented and wired into real execution paths; typecheck clean; lint clean.
- Environment constraint: YouTube player endpoints are bot-blocked from this sandbox IP → resolver chain degrades explicitly (duration null + requiresManualDuration; transcript source 'none'). Manual duration + manual transcript flows are first-class and fully functional.

---
Task ID: 10-11 (verification)
Agent: Z.ai Code (senior engineer)
Task: Phase 20 — execute tests A-K, browser verification, fix defects found during testing.

Work Log (tests executed + exact results):
- tests/clipforge-unit.ts → 48/48 PASS (after fixing 1 REAL bug it caught in sourceToOutputTime + over-aggressive title dedupe similarity).
- tests/clipforge-live.sh → 17/17 PASS:
  • Test A: /api/youtube/meta returns duration=null + durationSource='unavailable' + requiresManualDuration=true on bot-blocked IP (NO fake 720). Title/author resolved via oEmbed.
  • Test B: analyze with transcript → hooks verbatim from transcript, hookVerified=true (LLM quoted "most people think intelligence is about compute." etc.).
  • Test C: analyze without transcript → all spokenHooks empty + hookVerified=false (no fabrication).
  • Test D: totals server-calculated 0-100 (83, 87.8) — LLM totals ignored; unit test proves one-dimension change moves total by weight×10.
  • Test E: requested 6 → server returned 2 valid (≤6, dedupe enforced; small transcript = fewer valid candidates, honest).
  • Test F: overlapping candidates removed by dedupeAndRank (unit-verified).
  • Test G: 3× bulk save → exactly 2 clips in DB (transactional replace) — verified via API AND via UI triple-click.
  • Test H: session B gets 404 on A's project, 404 on A-scoped analyze, 400 on projectId-less /api/clips, empty project list.
  • Test K: SRT/VTT from real word timestamps ("it is not it is about memory…" — actual speech, no titles); SRT without transcript → explicit 422.
- Test I (timeline): ASS events verified source→output: sub @source 6-11 → output 1-6; sub @source 26-30.5 → output 11-15.5 (cut 15-25 removed); sub inside cut range DROPPED. Rendered-frame inspection confirmed burned subtitle position+timecode alignment (source timecode 28.08 at output 13.08 = 13+5 clip start+10 cut). ✅
- Test J (render): synthetic 40s 720p source → rendered: duration EXACTLY 20.000000s (30s clip − 10s cut), 1080×1920, H.264+AAC, playable, downloaded end-to-end via /api/render-proxy. ✅
- Plan API live test: subtitlesSource='transcript', 4/4 subtitle blocks composed ONLY of transcript words, all within clip range, cuts are pause-trims. ✅
- Browser verification (agent-browser): page renders; explicit duration-unavailable warning UI; golden path manual-duration+transcript → analyze → 2 clips with "verified in transcript" badges, avg 84/100; Save 3× → 2 clips (DB check); AI plan dialog → verbatim transcript subtitles + segments/cuts/camera; Export dialog with JSON/CSV/SRT/VTT/EDL. ✅
- Defects found & fixed during verification:
  1. sourceToOutputTime double-counted kept ranges (unit test caught) → rewritten against cuts directly.
  2. Render pipeline `-c copy` keyframe snapping (25.19s instead of 20s) → replaced with frame-accurate filter_complex trim/atrim+concat single pass (+ silent-audio fallback). Output now exactly 20.000s.
  3. libass misparses `HH:MM:SS.mmm` timestamps (events lingered past end) → new timeToAss() emits canonical `H:MM:SS.cc`. Verified: gap zones empty, event boundaries exact.
  4. PATCH /api/clips/[id] dropped clipTranscript/clipWords → added.
  5. Manual duration didn't propagate to session meta → plan generation was blocked after manual-duration analyze → fixed (meta updated + project duration PATCHed on save).
- README.md rewritten with honesty guarantees, pipeline, security model, renderer internals, environment constraints, test commands, production notes.

Stage Summary:
- Status: MVP+ (beta). Analysis pipeline real & verified end-to-end; render pipeline frame-accurate; security enforced; all exports honest.
- Remaining limitations: (1) YouTube metadata blocked on this sandbox IP → manual duration/transcript flows are first-class there; (2) ASR (faster-whisper) for uploaded files not yet integrated (schema supports words end-to-end); (3) B-roll/SFX/music/animations remain preview-only recommendations (clearly labeled); (4) renderer extraction accuracy now exact but slower (single re-encode).

---
Task ID: cron-1 (webDevReview round 2)
Agent: Z.ai Code (autonomous review)
Task: Status assessment + QA; ASR integration (uploads → faster-whisper word timestamps); styling additions.

Work Log:
- Status assessment: services healthy (Next 200, renderer up), unit 48/48 + live 17/17 green before starting.
- NEW FEATURE — real ASR for uploaded media (closes the last pipeline gap):
  • scripts/asr-transcribe.py: faster-whisper tiny/int8 CPU worker, word_timestamps=True + VAD, JSON output {text, words[{word,start,end}], language, duration, model}, explicit error codes (ASR_UNAVAILABLE / NO_SPEECH / ASR_FAILED).
  • POST /api/source/transcribe (multipart ≤500MB): ffprobe real duration (durationSource='ffprobe'), ffmpeg 16k mono extraction, ASR worker (10 min timeout), persists Project (transcriptSource='asr', transcriptWords) + ASR model metadata into analysisMeta; SourceJob states QUEUED→DOWNLOADING→TRANSCRIBING→COMPLETED/FAILED; rate-limited 6/min; owner-scoped.
  • Verified with REAL speech (TTS-generated 38s English narration): 84 words with precise timestamps ("Welcome" 0→0.48s…), duration 38.1s via ffprobe; ASR words fed through /api/clips/analyze → verified hook (total 82.7, ctx=EXTEND).
- Frontend upload flow (url-input.tsx): "Upload video / audio" in Advanced panel → XHR upload progress → job polling (DOWNLOADING/TRANSCRIBING stages shown) → done state shows word count + ffprobe duration chips → Auto-Clip consumes words+projectId+preResolvedMeta (no YouTube call). Auto-Clip button enabled for upload-mode.
- Browser-verified end-to-end: real file input upload → "Running faster-whisper… 45%" → "84 words with timestamps" → Auto-Clip → 2 clips, "verified in transcript", "ctx pass", POST badges; Source Data Provenance panel: duration 38s·ffprobe + transcript Whisper ASR + 84 word timestamps.
- BUG FIXED: analyze body used stale projectId state on first ASR run → transcript fallback never triggered → ungrounded result ("Unable to analyze without transcript"). Fixed via preSetProjectId ?? projectId; analyze API also synthesizes transcript from words when text absent (belt-and-braces).
- STYLING/UX additions:
  • SourceStatusPanel (new component): honest provenance chips (duration source / transcript source / word-timestamp count) + explicit rose warning when no transcript + "View transcript" entry point.
  • TranscriptViewer dialog (new): full transcript, live search with hit count + <mark> highlighting, copy button, hoverable word-timestamp chips, thin scrollbars; works for ASR (words), manual paste (text) and project-loaded sources.
  • video-preview.tsx: stylized "Local media — analyzed via ASR" placeholder card for uploads (no broken empty YouTube iframe); external link guarded for upload:// URLs.
  • loadProject: upload projects render with Local upload provider + no embed.
- QA after changes: tsc clean, eslint clean, unit 48/48, live 17/17, transcript search "memory" → 2 hits highlighted in UI.

Stage Summary:
- Pipeline is now closed end-to-end including uploads: file → ffprobe duration → Whisper word timestamps → transcript-grounded analysis → validated clips. transcriptSource='asr' is a first-class grounded source.
- Remaining: PostgreSQL prep, shared rate-limit store, larger ASR models (base/small) as an option, renderer progress reporting granularity.

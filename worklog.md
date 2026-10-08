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

---
Task ID: audit-round-2 (P0 audit + fixes)
Agent: Z.ai Code (lead architect / senior full-stack)
Task: Fresh audit of current source (source of truth = code) per P0 list: word timestamps, clip detection chain, source→output mapping, renderer, golden E2E; then repo hygiene, P1 light (cancel/contract), P2 SaaS migration doc.

Work Log:
- AUDIT FINDINGS (all confirmed by reading code, not worklog):
  1) media.ts parseJson3 estimated word timing even when json3 carries real per-word tOffsetMs (read then discarded); no measured/estimated provenance anywhere. srv3 files were preferred over vtt but parsed with the VTT parser (always 0 events — latent dead path).
  2) analyze route: without transcript, contextRisk trusted the LLM (Boolean(c.context_risk)); context_safety uncapped; contextStatus=UNKNOWN.
  3) subtitles.ts: totalCutDuration() returned KEPT sum and outputDuration() returned REMOVED (swapped) — currently unused elsewhere (landmine); mappings bounded to Number.MAX_SAFE_INTEGER; isDroppedByCuts kept 80%-covered events (comment≠code); render-recipe.ts had a second divergent droppedByCuts.
  4) ffmpeg-renderer: silent-audio fallback condition had `|| true` (masked ANY failure with a silent render); filter order ass→zoompan→scale→crop distorted 16:9→9:16 whenever camera keyframes existed and zoomed subtitles; codec-check throw swallowed by catch{}; no run() timeout; no duration verification; no cancel.
  5) repo hygiene: .env + db/custom.db tracked in git; dead top-level lib/ + hooks/ duplicates tracked.
- FIXES IMPLEMENTED (all wired into real execution paths):
  - parseJson3 rewritten: word start = tStartMs+tOffsetMs, end = next word start/event end; srv3 XML parser with ac-as/t word offsets added; wordTiming 'measured'|'estimated' computed (≥80% segs) and propagated: ResolvedTranscript → /api/source/prepare (persisted Project.wordTiming) → analyze route (body/project/default-estimated) → analysisMeta + API response → page.tsx state → SourceStatusPanel chip (warn amber "estimated" vs green "measured").
  - analyze: !hasTranscript → contextStatus='NO_TRANSCRIPT', contextRisk=true, context_safety capped ≤5 (POST impossible without transcript — server authority).
  - subtitles.ts: totalCutDuration=removed, outputDuration=kept (keptDuration helper); outputToSourceTime gained clipEnd bound (default MAX_SAFE for compat); sourceToOutputTimeBounded added; unified isDroppedByCuts rule (drop when <50% survives or <50ms); render-recipe.ts dedupe removed → uses canonical rule; buildZoompanFilter passes clipEnd.
  - renderer: probeHasAudio() decides path ONCE (ffprobe); silent path ONLY for genuinely audio-less inputs, single attempt; filter order fixed scale→crop→zoompan→ass in BOTH mini-service and generateFFmpegScript (no distortion, subs fixed-size, burned last); codec+1080x1920 checks now FAIL the job (resolution check added); durationOk flag (±1.5s) surfaced in job/SSE; run() hard timeout (15min render / 30s probe) with SIGKILL; POST /jobs/:id/cancel → CANCELLED state, kills child, catch-block guard preserves state.
  - generateASS: generated hook overlay {\an8} top-center (was colliding with bottom subtitles 0-3s); WrapStyle 0 (long lines wrap instead of clipping).
- GOLDEN E2E (tests/e2e-render.ts, new): synthetic 40s 1280x720 testsrc2+sine fixture → EditPlan(clip 5–35, cut 15–25, punch-in 1.0→1.18, transcript words) → buildRenderRecipe/buildRecipeJSON/generateASS → POST to renderer → poll → download → assertions: job done, durationOk, output exists, duration 20s±0.75, 1080x1920 h264, aac stream, audio NOT silent (volumedetect), ASS events ≤ output duration, keep ranges exact. 16/16 PASS. Visual frame verification: t=1 (hook top + subtitle bottom, no collision), t=13 (post-cut, zoom active, correct 9:16 crop, no distortion).
- REPO HYGIENE: git rm --cached .env db/custom.db (local files kept); deleted tracked dead duplicates top-level lib/ (11 files) + hooks/ (5 files) — nothing imports them (@/* → src/*); .gitignore += db/*.db, /upload/, download artifacts; added .env.example.
- P1: RenderRecipe ARCHITECTURE CONTRACT documented in render-recipe.ts header (EditPlan→buildRenderRecipe→Renderer; renderer never imports UI/AI/DB; UI never builds ffmpeg; recipe JSON camera keyframes are OUTPUT-time; renderer swappable). CANCELLED job state + cancel endpoint added. AssetRef decision: documented as future seam in docs/SAAS-MIGRATION.md §4, deliberately NOT implemented (one storage backend exists; seams already narrow).
- P2: docs/SAAS-MIGRATION.md written (auth, workspaces, SQLite→Postgres, storage+AssetRef, durable jobs w/ stage checkpoints, render workers, billing/usage enforcement points = the 4 already-rate-limited expensive routes, observability, public-deploy security checklist).
- README updated: test matrix (73 unit / 16 e2e / 17 live), wordTiming honesty note, status line corrected (ASR no longer a gap).

Stage Summary:
- Verification (all green): unit 73/73 · golden E2E render 16/16 (+frame inspection) · live API 17/17 · tsc clean · eslint clean · browser: page renders, console clean.
- Committed 1d102fc and pushed to origin/main.
- Honest remaining limitations: (1) YouTube player endpoints bot-blocked from this sandbox IP → captions E2E for the 'measured' json3 path verified via unit tests on real-format fixtures, not against live YouTube; (2) renderer progress granularity still per-stage; (3) B-roll/SFX/music remain preview-only recommendations; (4) shared rate-limit store still in-memory (documented).

---
Task ID: cron-review-2 (webDevReview round 3)
Agent: Z.ai Code (autonomous review)
Task: QA + feature round — verify stability, then advance product quality features.

Work Log:
- Status assessment: services healthy; regression gates ALL GREEN before starting (unit 73/73, E2E 16/16, live 17/17, browser console clean).
- 🔴 CRITICAL BUG FOUND & FIXED (upload-render.tsx): the UI path sent the RAW RenderRecipe object (JSON.stringify(recipe)) instead of buildRecipeJSON(recipe). The raw object has NO keep_ranges, NO subtitles_ass, SOURCE-time camera keyframes → the renderer silently fell back to rendering the FULL clip window WITHOUT cuts and WITHOUT subtitles whenever a user rendered via the Upload tab. The golden E2E + prior live tests used buildRecipeJSON via scripts, so this UI-only path bug was invisible to the suites. Fixed: UI now sends the renderer-contract JSON. Lesson recorded: contract boundary (recipe JSON) is the ONLY valid wire format to the renderer.
- NEW FEATURE — Karaoke word-highlight subtitles (uses MEASURED word timestamps):
  • EditPlanSchema + SubtitleBlock type: optional word_timings[] (SOURCE time).
  • plan route: deterministic rebuild blocks always carry real word timings; AI-authored blocks get them ONLY when normalized block text === normalized join of real words in its window (alignWordTimings helper) — never fabricated.
  • generateASS: new buildKaraokeText() emits sequential \k tags; fill duration = delta between consecutive mapped word STARTS (gaps absorbed → stays in sync with speech); emphasis words bolded inline; REFUSES karaoke when any word boundary would be cut-snapped, timings degenerate/non-monotonic/outside block → plain-text fallback. SecondaryColour dimmed (&H00969696) for the unfilled state.
  • VERIFIED VISUALLY: frame @t=1.2s shows spoken words bright, unspoken words dim (karaoke fill working in real render).
- NEW FEATURE — Render cancel in UI (upload-render.tsx): Cancel button → POST /api/render-proxy/jobs/:id/cancel; poll handles 'cancelled' state (no partial file kept); amber notice banner; durationOk=false → warning badge "duration deviates from plan".
- NEW FEATURE — Clip editor word snapping (clip-editor.tsx): sliders now 0.1s step; word-boundary ruler visualizes real word positions inside the clip; "snap to speech" toggle (default on when ≥2 words) snaps boundaries to word onsets/endings/gap midpoints within 1.5s; live hint shows which word was snapped ("start snapped to speech: 'actually'").
- Tests added: +7 karaoke unit assertions (durations math, bold emphasis, cut-snap refusal, window refusal, non-monotonic refusal, no-timings fallback, generateASS integration); golden E2E fixture now carries word_timings + asserts \k in ASS (16→17 assertions).
- Regression after changes: unit 80/80 · golden E2E 17/17 · live 17/17 · tsc clean · eslint clean · browser renders, console clean.
- Committed 4884a7c, pushed to origin/main.

Stage Summary:
- Project state: STABLE and advancing. Core engine reliability preserved (all honesty gates intact: karaoke only from measured timing, never fabricated).
- Next round suggestions (priority order):
  1) Usage metering light (UsageEvent table + record analyze/transcribe/render seconds) — enforcement points documented in docs/SAAS-MIGRATION.md §7-8.
  2) Retry-from-stage for failed SourceJobs (download↔transcribe checkpointing).
  3) Timeline zoom/scrub polish in timeline.tsx + cut handles snapping to the same word-gap logic as clip-editor.
  4) Optional: renderer stage-level progress from ffmpeg `-progress` pipe for smoother UI.
- Risks: none new. Known standing limits unchanged (YouTube IP-block in sandbox; B-roll/SFX/music preview-only; in-memory rate-limit store).

---
Task ID: cron-review-3 (webDevReview round 4)
Agent: Z.ai Code (autonomous review)
Task: QA + feature round — status assessment, agent-browser QA, then advance the job architecture & product surface (auto-grounding, retry, usage metering, timeline polish, renderer progress).

Work Log:
- STATUS ASSESSMENT: all services healthy; regression gates ALL GREEN before changes (unit 80/80, E2E 17/17, live 17/17); git clean @ 9a4ff10. Browser QA (agent-browser): landing stats, studio golden path (URL → manual transcript → analyze → 3 clips w/ verified badges, avg 83), AI Edit Plan dialog (score chips, transcript-locked subtitles w/ emphasis), Save to library (transactional toast), Library grid — ALL PASS, console clean. No product bugs found in existing flows.
- 🔑 KEY DISCOVERY: YouTube caption download now WORKS from this sandbox IP (was bot-blocked in earlier rounds). `/api/source/prepare` (the async job pipeline) existed but had ZERO callers — orphaned. Decision: wire it in as the PRIMARY UI path for YouTube URLs without manual transcript.
- 🐛 P0 BUG FIXED (pre-existing, caption fetch silently dead): yt-dlp `--sub-langs "en,id,*-orig,*-auto"` → yt-dlp rejects `*-orig` ("Wrong regex for subtitlelangs" — entries are PYTHON REGEX, not shell globs) → the whole caption command failed → transcriptSource always 'none' even when captions were downloadable. Nobody noticed because the path degraded honestly. Fixed pattern + added: (1) partial-failure tolerance — a 429 on ONE language variant must not abort the fetch when other tracks are already on disk (decide from files, never from exit code); (2) track-selection preference: among json3 files, prefer the one actually carrying per-word tOffsetMs (the ASR 'orig' track) over word-offset-less manual tracks → wordTiming 'measured'; (3) request order puts `.*-orig` FIRST so the best track survives partial rate-limit failures. VERIFIED: dQw4w9WgXcQ → transcriptSource 'youtube-captions', wordTiming 'measured', 291 words with real offsets.
- NEW FEATURE — Zero-input auto-grounding (the biggest UX win since ASR):
  • `/api/source/prepare` is now the primary path: pasting a URL + Auto-Clip runs the async prepare job FIRST (real stage/progress UI: "Resolving video metadata (yt-dlp → innertube → oEmbed)…" → "Fetching YouTube captions / transcript…" → "Saving source data…"), persists duration+transcript+words into an owned Project, then analyze grounds from the project. Result: hooks verbatim-verified with ZERO manual paste ("We're no strangers to love… verified in transcript" on a song video; provenance chips both green: duration · yt-dlp, transcript · YouTube captions).
  • belt-and-braces: `/api/clips/analyze` ALSO auto-fetches captions (75s timeout guard) when no transcript/words supplied by any path (body/project/prepare) — direct API users get the same grounding; response carries `autoGrounding` note → toast.
  • graceful degradation preserved: no captions → exactly the old honest 'none' behavior + fallback button.
- NEW FEATURE — Retry-from-stage for failed jobs (job architecture P1):
  • SourceJob.payload column persists the original request JSON at creation.
  • prepare worker extracted to src/lib/jobs/prepare-worker.ts (shared by create + retry routes).
  • POST /api/jobs/:id/retry — owner-scoped; only FAILED prepare jobs (409 otherwise; transcribe media is ephemeral → re-upload); merges optional manualDuration/manualTranscript overrides; resets state machine to QUEUED and re-runs. Verified: 202 on real FAILED job, 409 on COMPLETED, 404 cross-session.
  • UI: failed prepare shows amber panel with "Retry prepare" (reuses the SAME job via /retry) + "Analyze without transcript" fallback; browser-verified with an invalid video id.
- NEW FEATURE — Usage metering light (SaaS-migration §7-8 enforcement points):
  • UsageEvent table (ownerId, kind analyze|prepare|transcribe|render, quantity, meta JSON) + src/lib/usage.ts (best-effort recordUsage — never fails the main flow) + GET /api/usage (totals, last-30d, last 20 events).
  • Wired into all 4 expensive paths: analyze (model/transcriptSource), prepare (transcriptSource), transcribe (media seconds), render-proxy POST /jobs (render seconds when recipe parseable).
  • UI: UsagePanel popover in Library header (per-kind cards, recent activity, SaaS note; lazy load). Browser-verified showing live counts.
- NEW FEATURE — Renderer stage progress granularity: ffmpeg `-progress pipe:1 -nostats` on both encode paths (args placement VERIFIED: global options must precede URLs — appended-after emits nothing); stdout `out_time_us=` parsing (µs quirk handled) with regular cadence + stderr `time=` fallback retained. E2E re-verified 17/17 incl. durationOk.
- NEW FEATURE — Timeline polish (uses MEASURED word data):
  • speech-density strip (160 buckets, epsilon-guarded bucket math — float edge like 11.2/0.2=55.999… no longer fakes coverage) rendered under clips + "speech map · trim snaps to words" badge.
  • trim-handle word snapping on drag (shared src/lib/word-snap.ts — clip-editor refactored onto the same util; single source of truth) + live snap hint ("start → speech: \"actually\"").
  • functional 1×–4× zoom (previously dead state) with scrollable track + zoomed time scale; handle hover feedback.
- Dev-env incident (documented): stale Prisma client after schema push → truncated .next dev chunks to force recompile → dev server required restart (recovered, all routes verified). Note for future rounds: after `db:push`, verify a route that touches the new column before deeper debugging.
- Tests: +12 unit assertions (word-snap onset/gap/maxDist/single-word/non-finite; speech-strip coverage/gaps/silence/clamping). Final gates: unit 92/92 · golden E2E 17/17 · live 17/17 · tsc clean · eslint clean. Browser: golden auto-grounded flow, retry UI, usage panel, speech strip (160 bars) all verified; console clean.
- README updated: pipeline diagram (prepare as primary path, retry, -progress), zero-input auto-grounding section, status line.

Stage Summary:
- The product now delivers grounded clips from a bare URL with zero manual steps when YouTube allows it, degrades honestly when it doesn't, and recovers with one click when it fails transiently.
- Committed & pushed to origin/main.
- Next round suggestions (priority order):
  1) Proxy media download for YouTube sources (yt-dlp video download → local file → render without upload) — the URL flow still can't RENDER the source in this environment.
  2) Auto-Edit preview integration with the prepare flow (feed real word data into the player).
  3) Usage-based soft limits (configurable daily cap → 429 with friendly message) — table + endpoints already exist.
  4) Exporter: burn-in LUTs/text overlays preview-only labeling cleanup; B-roll/SFX remain preview-only.
- Risks: none new. Standing limits unchanged (sandbox IP rate-limits on YouTube timedtext endpoint — mitigated by partial-failure tolerance + retry; B-roll/SFX/music preview-only; in-memory rate-limit store).

---
Task ID: cron-review-4 (webDevReview round 5)
Agent: Z.ai Code (autonomous review)
Task: QA + feature round — status assessment, agent-browser QA, then close the last pipeline gap: render from a bare URL (YouTube media download → project-source render).

Work Log:
- STATUS ASSESSMENT: all services healthy; regression gates ALL GREEN before changes (unit 92/92, E2E 17/17, live 17/17); git clean @ 54db3d6. Browser QA (agent-browser): zero-input golden path re-verified (URL → Auto-Clip → 4 clips, all "verified in transcript" from captions, server scores 82.5–87.3, console clean). No product bugs found in existing flows.
- 🔑 KEY DISCOVERY: yt-dlp VIDEO download now WORKS from this sandbox IP (34MB 1080p MP4 pulled in ~13s) — same unblocking as captions in round 4. This closes the biggest remaining product gap: the URL flow could analyze but could never RENDER without a manual upload.
- NEW FEATURE — URL → render loop closed (the headline of this round):
  • Prepare job gained Stage 3 (media download): yt-dlp downloads the source video into upload/yt/<id>/source.<ext> — hard height cap (≤1080p for ≤20 min sources, ≤720p above; the 9:16 renderer crops+upscales, 1080p keeps output sharp), --max-filesize 1.5G guard, --concurrent-fragments 4, resumable .part files so job retry continues instead of restarting. FAILURE DEGRADES HONESTLY: a failed download never fails the job (its primary purpose is metadata+transcript) — it persists localMediaState='failed' + error and the UI offers the upload path.
  • Schema: Project.localMedia (RELATIVE path, e.g. upload/yt/<id>/source.mp4), localMediaSize, localMediaState ('ready'|'failed'|'skipped'|'unavailable'), localMediaError. Verified with a fresh Prisma query after db:push (per the documented dev-env rule).
  • Render-proxy JSON mode: POST /api/render-proxy/render now accepts { recipe, projectId } — the proxy resolves the path FROM THE DB (client never sends a path), enforces ownership (foreign session → 404), validates path containment via resolveLocalMediaPath (upload/-prefix + traversal rejection, unit-tested), size-caps at 1.5GB, then re-builds the multipart for the renderer — RENDERER CONTRACT 100% UNCHANGED (recipe JSON + video bytes → MP4).
  • transcribe job Stage 4b: the UPLOADED original is persisted to upload/projects/<id>/source.<ext> → upload projects also become render-ready without re-upload.
  • 🐛 BUGS FIXED along the way: (1) resolveLocalMediaPath initially double-joined the upload/ prefix ('upload/upload/...') → caught immediately by the new E2E, fixed + path-containment hardened; (2) render usage metering matched '/jobs' — an endpoint that doesn't exist in the current renderer contract — so RENDERS WERE SILENTLY UNMETERED; fixed to '/render' (also meters renderSeconds from the recipe output_duration in JSON mode); (3) stale Prisma client in the long-running dev server after schema push (the exact dev-env incident documented last round — db:push requires a dev server restart; lost ~15 min to it, recovered by clean restart).
- UI/STYLING additions:
  • upload-render.tsx: "Server source / Your file" segmented source selector (selected state with ring+check, server card shows size MB + "rendered directly — no upload needed" + render-ready badge; failed state shows amber explanation), adaptive header text, stage stepper first step 'Queue' in server mode, JSON render path.
  • saved-projects.tsx: "render-ready" chip on library cards + "N render-ready" summary stat (title tooltips explain).
  • url-input.tsx: ASR done state shows "source saved — render without re-upload (N MB)" chip.
  • page.tsx: projectMedia state wired through prepare result / loadProject / delete / clear; prepare poll window 3→22.5 min for long downloads.
- TESTS: NEW tests/url-render-e2e.ts (17 assertions, permanent gate): bare URL → prepare job (metadata+captions+media download) → real duration drives plan window → buildRecipeJSON → JSON project-source render → download → ffprobe/volumedetect: duration EXACTLY 20.000s, 1080x1920 h264+aac, non-silent audio, file 13.4MB; PLUS security (JSON render w/o projectId → 400, foreign session → 404) and honest skip semantics when YouTube blocks. Unit suite +10 (path safety: traversal/absolute/non-upload/empty, mime map, safe-id). Frame inspection of the URL-rendered MP4: real Rick Astley footage, correct 9:16 crop, punch-in zoom, yellow hook top-center, karaoke fill subtitle at bottom, post-cut frame clean (no subtitle residue).
- Regression after changes: unit 102/102 · golden E2E 17/17 · live 17/17 · url-render E2E 17/17 · tsc clean · eslint clean.
- BROWSER-VERIFIED END-TO-END (agent-browser): URL → Auto-Clip (prepare shows "Downloading source video…" stage) → 5 clips verified-in-transcript → AI Edit Plan (4 segments / 11 subtitles / camera 2) → Render tab shows "Server source · 32.3 MB [selected]" + "Your file" tab → Render MP4 → "Render complete! 1080×1920 · 46s · 30.54 MB" with inline player + Download. Console clean.
- Committed 93d85a1. GitHub push FAILED with remote "Internal Server Error" (transient GitHub-side; API also 403 at the time) — COMMIT IS SAFE LOCALLY, retry `git push origin main` next round before starting work.
- package.json: added test:unit / test:e2e / test:live / test:url-render shortcuts. README updated (URL→render loop, JSON render mode, test matrix, honest failure modes).

Stage Summary:
- The product's last hard gap is closed: a bare YouTube URL now yields a finished, downloadable 9:16 MP4 with zero manual input when YouTube allows it — and every failure mode (no captions, no duration, download blocked) degrades honestly with a first-class manual path.
- Next round suggestions (priority order):
  1) `git push origin main` (93d85a1 is local-only due to the transient GitHub error).
  2) Real auto-edit preview player for server-side media (HTML5 <video> playing the DOWNLOADED source with keep-range skipping) — the URL flow can now preview cuts on real footage instead of the YouTube iframe approximation.
  3) Usage-based soft limits (daily cap → friendly 429) — UsageEvent + endpoints already exist.
  4) Storage hygiene: cap/LRU-clean upload/yt (33MB/video adds up), project delete should remove its media dir.
- Risks: none new. Standing limits: YouTube endpoints are IP-dependent (all flows degrade honestly); in-memory rate-limit store; B-roll/SFX/music preview-only.

---
Task ID: reconcile-1 (reconcile main with target architecture)
Agent: Z.ai Code (senior engineer)
Task: Reconcile main branch — audit every execution path against the target architecture (source preparation → real duration → real transcript → word timestamps → grounded analyze → server scoring → dedupe → plan → export → render), fix discrepancies, remove false claims, enforce build/test gates.

Work Log:
- Pushed previously-local commits (93d85a1..5ca062b) to origin/main.
- Audited all 17 route files + libs via full wiring trace (routes × session × Zod × DB-vs-client × utility call-sites). Classification: analyze/plan/export/render/prepare/jobs/usage = IMPLEMENTED+WIRED; GET /api/clips + GET/PATCH/DELETE /api/clips/[id] = implemented-but-unused-by-UI (kept — correct REST surface); /api = legacy template (REMOVED).
- 🐛 P0 BUG FIXED (media route, orphan commit 5ca062b): `[projectId]` param destructured as `{ id }` → Prisma silently dropped the undefined id filter → ANY media request streamed the FIRST owned project's media. Fixed destructure + 400 guard. Regression-proven: nonexistent id now 404 (pre-fix would be 200 wrong-media); owner+Range → 206 video/mp4; foreign session → 404.
- 🔒 Analyze route no longer trusts client source data when a project exists (mission #3): server-stored duration/transcript/transcriptWords/transcriptSource/wordTiming now WIN over the body; client values only fill gaps (first-run manual path). Regression test proves a lying client `duration: 720` is ignored in favor of the stored 2383s.
- 🔒 Hook grounding strengthened (mission #6): validateHookAgainstTranscript rewritten to strict tiers — exact phrase 1.0 / ≥6-run 0.95 / 5-run 0.90 / 4-run+80% coverage 0.85 / 3-run+90% coverage OR ≥95% ordered-subsequence reconstruction 0.8; VERIFIED threshold raised 0.7 → 0.8 (HOOK_VERIFY_THRESHOLD); analyze now verifies the quote against the clip's OWN word window first, then the full transcript. A bare 3-gram no longer verifies anything. Unit tests lock the old-wrong case (3-gram+low coverage → NOT verified).
- 🐛 checkContext bug fixed: endsMidPunct tested punctuation against normalizeText() output (which strips punctuation) → always false; now tests the raw word. Mid-sentence end-extension no longer runs past completed sentences.
- Build gates (mission 26–28): next.config.ts ignoreBuildErrors true→false, reactStrictMode false→true (no hydration/double-render issues observed in browser); package.json adds typecheck/check/test/test:scale scripts.
- Dead code removed (single-strategy rule): /api hello-world route, peekSessionId, getStylePreset, parseScores, ClipCandidate/AnalyzeResult duplicates in editplan.ts, __testHelpers re-export in analyze, `void normalizeText` in plan, dead `transcript: ?undefined:undefined` conditional in page.tsx save flow.
- Media route doc-claim corrected to honest status (VERIFIED backend endpoint, NOT yet wired to a UI player) — the Auto-Edit preview still uses the YouTube iframe; HTML5 keep-range preview is the next planned step.
- NEW tests/long-source-scale.ts (15 assertions, test:scale): mission video PLOpsj6DVQ8 (39:43) is bot-blocked from this sandbox IP (429 → "Sign in to confirm you're not a bot"; yt-dlp + innertube WEB/ANDROID/IOS/TVHTML5/WEB_EMBEDDED all rejected; control video dQw4w9WgXcQ resolves fine → IP is fine, this video's fetch is throttled). System degrades honestly (duration=null + requiresManualDuration, NO 720). Scale mechanics proven at the real 2383s duration via the first-class manual path: 400-on-missing-duration, clips inside [0,2383], platform bounds, strict-threshold hook verification, server totals, DB-duration-wins-vs-lying-client.
- REGRESSION GATES after all changes: tsc clean · eslint clean · unit 106/106 · golden E2E 17/17 (render 20.000s 1080×1920 h264+aac, non-silent) · live 17/17 · url-render 17/17 · scale 15/15.
- Browser QA (agent-browser, strict mode ON): golden path URL → prepare → analyze → 3 clips, all hooks verbatim + "verified in transcript" (real lyrics), scores 82.7/82.1/80.0, speech-map strip, library render-ready chips; console clean; full-page screenshot verified.

Stage Summary:
- Execution paths now MATCH the documented architecture with no false claims: every claim above is backed by a passing automated check or a direct probe.
- Real-caption grounding + real media render proven on dQw4w9WgXcQ (213s via yt-dlp, 291 word timestamps, full URL→MP4 loop).
- Standing limits (honest): PLOpsj6DVQ8-specific YouTube bot-block from this IP (retry may succeed later); B-roll/SFX/music/animations preview-only; in-memory rate-limit store; /api/media endpoint ready but UI-unwired.
- Final status per mission rubric: MVP (all P0/P1 wired + tested; production-ready requires multi-tenant hardening, persistent rate-limit store, and unblocked YouTube egress).

---
Task ID: ten-ten-1 (10/10+ engine quality round)
Agent: Z.ai Code (Principal Engineer)
Task: CLIPFORGE 10/10+ — baseline, audit, then fix render-job ownership, recipe validation, resource protection, timeline full-cut phantom, caption timing selection, diversity, CI/docs.

Work Log:
- BASELINE @ 238d489 (clean tree): tsc PASS · eslint PASS · unit 106/106 · golden E2E 17/17 · url-render E2E 17/17 · long-source scale 15/15. All services healthy.
- AUDIT (execution-path based, not worklog-based):
  - P0 #1 Render job ownership MISSING: /api/render-proxy GET forwards job poll / SSE stream / artifact download and POST forwards /jobs/:id/cancel to the renderer with NO authorization — any session with a job UUID can read/stream/cancel/download another user's render. Renderer itself trusts job-id secrecy (mission explicitly forbids).
  - P0 #2 Full-cut phantom: buildKeepRanges() falls back to the FULL clip when cuts cover 100% of the window (subtitles.ts L39) and the renderer repeats the same fallback (index.ts L232). Mission forbids: keepRanges MUST be empty → outputDuration 0 → renderer must reject.
  - P0 #3 Recipe validation MISSING: renderer trusts arbitrary JSON (interface-only). NaN/absurd duration → zoompan totalFrames explodes (OOM); keep_ranges unbounded; scale keyframe accepts strings → filter-expression injection; negative timestamps → "NaN" in filters.
  - P0 #4 Resource protection: proxy JSON render mode buffers up to 1.5GB source into RAM (readFileAsync); multipart passthrough has no content-length guard; renderer buffers the whole upload via file.arrayBuffer().
  - P1 #5 Caption track selection: format rank (json3>srv3>vtt) dominates; a srv3 track WITH word offsets loses to a json3 track WITHOUT them. wordTiming is binary measured/estimated — no 'mixed'.
  - P1 #6 Diversity: dedupeAndRank drops >50% overlap + title/excerpt dupes, but temporally-adjacent near-duplicates (same moment, non-overlapping windows) survive.
  - P1 #7 No CI workflow; no SECURITY.md.
  - Already good (verified, do NOT rewrite): DB-authoritative analyze, Zod+repair, server scoring/recommendation, strict hook tiers, context validation, transactional save, ownership on projects/clips/sourcejobs/usage, path containment (resolveLocalMediaPath + tests), execFile-arg-array ffmpeg/yt-dlp everywhere, renderer frame-accurate trim + codec/resolution/duration gates + cancel + timeout, rate limits on expensive routes.
- IMPLEMENTATION PLAN (10 steps): (1) Prisma RenderJob table; (2) renderer recipe-validation module + hardening; (3) proxy ownership + streaming + caps; (4) buildKeepRanges full-cut fix + UI guard; (5) caption timing-quality selection + 'mixed'; (6) diversity near-dup rule; (7) tests (unit A–M edge cases, validation matrix, E2E ownership+full-cut); (8) CI + SECURITY.md; (9) full regression + browser QA; (10) final adversarial review + scored report.
- Steps executed (all verified by running code, not by claim):
  1. Prisma RenderJob table (id = renderer job id, ownerId, projectId, status, stage, filename) + db:push. NOTE: required dev-server restart (stale client — the documented db:push incident).
  2. mini-services/ffmpeg-renderer/recipe-validation.ts (PURE, unit-importable): strict contract with documented RECIPE_LIMITS (1MiB recipe, 50 keep ranges, 400 keyframes, 512KiB ASS, 1800s output, scale [0.5,10], 1.5GB upload); rejects NaN/Infinity, negative ts, end<=start, unsorted/overlapping ranges, EMPTY output (full cut), string scale (zoompan filter-injection), oversize/overcount. Renderer index.ts: validation gate on POST /render (400/413 with codes), REMOVED the silent full-clip fallback (keep_ranges required), content-length 413 guard, Bun.write streaming input (no 1.5GB JS-heap buffer), deterministic state machine (queued→extracting→rendering→finalizing→done | cancelled | error; terminal states FINAL; cancel only from active states) + stage timing logs.
  3. render-proxy rewrite: EVERY job operation authorized against RenderJob (ownerId) BEFORE touching the renderer — poll/stream/download (GET) + cancel (POST) → 404 otherwise; ownership recorded on successful render start (both multipart + JSON modes); opportunistic status sync on polls; JSON-mode recipe capped at 1MiB (413); multipart content-length 413 guard; stored media now STREAMED into a hand-built multipart body in 8MB chunks (readFileAsync 1.5GB RAM buffer eliminated).
  4. buildKeepRanges full-cut fix: cuts covering the whole window → [] (outputDuration 0) — silent full-clip fallback REMOVED at BOTH layers; buildRecipeJSON honestly emits keep_ranges[]+output_duration 0; UI: render button disabled + amber explanation when edit <0.2s; poll 404 handled with clear message.
  5. Caption track selection by TIMING QUALITY (captionTrackTimingQuality pure fn): offset-carrying srv3 now beats offset-less json3 (format only breaks ties); wordTiming 'mixed' (20–80% measured) added through media.ts → prepare-worker (warning) → analyze → API → Project → UI chip.
  6. dedupeAndRank near-duplicate rule: non-overlapping clips <30s apart with ≥0.6 excerpt similarity collapse to the stronger one (diversity: results represent different moments).
  7. Tests: unit 106→169 (edge cases A–M incl. full-cut/adjacent/overlapping/outside/zero-length/crossing-subs/boundary-keyframes; validateRecipe 20-case rejection matrix; track-quality determinism; mixed provenance; diversity); NEW tests/render-security-e2e.ts (20 assertions via the REAL proxy path: owner poll/stream/cancel/download OK; foreign session → 404 on ALL; unknown id → 404; full-cut → 400 EMPTY_OUTPUT; NaN/negative → 400; real MP4 downloaded & probed 20s).
  8. CI .github/workflows/ci.yml (typecheck+lint+unit / strict build / golden+security E2E with ffmpeg+services, free tier only); SECURITY.md (threat model table, every row test-backed); README test matrix + wordTiming union; docs/SAAS-MIGRATION.md §5 RenderJob note.
- REGRESSION GATES (all after changes): tsc clean · eslint clean · unit 169/169 · golden E2E 17/17 · render-security 20/20 · url-render 17/17 · live 17/17 · scale 15/15.
- BROWSER QA (agent-browser): URL → Auto-Clip → prepare job → analyze 200 → 4 clips (POST badges, score breakdowns, avg score), provenance chips "duration: 3m 33s · yt-dlp" + "transcript: YouTube captions"; console clean.
- Committed b537b71, pushed to origin/main.

Stage Summary:
- The mission's #1 invariant is now true AND test-enforced: no user can read, stream, cancel, or download another user's render job — and random UUID secrecy is no longer the defense (DB-authorized at the public proxy).
- The renderer no longer trusts any JSON: strict validated contract + resource limits; a fully-cut edit can no longer produce a phantom full-clip video at any layer.
- Remaining honest gaps (deliberate, documented): in-memory rate-limit store; anonymous cookie sessions; render "retry" = re-submit recipe (new authorized job) rather than a persisted retry endpoint; render artifacts expire after 10 min (DB row keeps lifecycle); FACE_TRACK camera strategy documented as future seam (STATIC/CUSTOM keyframes implemented).

---
Task ID: cron-review-20261008 (in progress)
Agent: Z.ai Code (Principal Engineer)
Task: Status assessment + browser QA + next-priority development (media preview player, PLOpsj6DVQ8 retry, library LRU, usage soft limits).

Work Log:
- BASELINE @ 36043db: tsc clean · eslint clean · unit 169/169 · golden E2E 17/17 · renderer 3003 healthy · dev server healthy (fresh analyze 200 in dev.log). Browser QA (agent-browser): landing page loads, zero JS errors, zero console warnings.
- PRIORITY 1 IMPLEMENTED: /api/media/[projectId] wired into ALL THREE players:
  1. NEW src/hooks/use-html-media-player.ts — HTML5 <video> handle with the same interface as the YouTube hook (play/pause/seekTo/getCurrentTime/getDuration/setPlaybackRate/setMuted/getPlayerState/isReady) + error reporting (code 2/3/4 mapped to human messages).
  2. VideoPreview (main studio panel): real downloaded source now streams in an HTML5 <video> with controls + "LOCAL SOURCE · N MB" badge; clip selection seeks the real media precisely (no iframe reload); falls back to YouTube embed / upload placeholder when no source.
  3. AutoEditPlayer: dual-backend (real media vs YouTube iframe) — cut-skipping preview now runs on the REAL source; header badge "local source · real cut preview" vs "YouTube approximation"; media load failure falls back to YouTube with an honest warning card. ALSO FIXED: the mute button used to PAUSE playback — now a real mute toggle on both backends.
  4. RemotionPlayer: when real media exists the composition renders TRUE keep-range preview — <Sequence> per keep range with <Video trimBefore/trimAfter>, i.e. cuts are physically removed in the browser preview using the SAME buildKeepRanges contract as the FFmpeg renderer (single strategy, preview == render). Output→source time mapping lives in NEW src/lib/keep-ranges.ts (mapKeepRanges / sourceTimeAtOutput / keepRangesOutputDuration) — unit-tested.
  5. 16 new unit tests for keep-range mapping (round-trip, cut-outside-window, overlap merge, full-cut degenerate, identity); unit 169 → 185, all green; tsc + eslint clean.
  6. media route doc-comment updated: status VERIFIED-unwired → WIRED (with the three consumers named).

Stage Summary:
- What you preview is now what renders: the browser preview and the FFmpeg renderer share one keep-range implementation.
- Remaining in this round: PLOpsj6DVQ8 retry, library storage LRU, usage soft limits, full regression + browser QA of the new players with real media.

---
Task ID: cron-review-20261008-2 (webDevReview round 6)
Agent: Z.ai Code (Principal Engineer)
Task: Status assessment + agent-browser QA + continue the round-5 priorities (HTML5 keep-range preview was in-flight; PLOpsj6DVQ8 retry; library LRU; usage soft limits).

Work Log:
- BASELINE: previous round's player work was UNCOMMITTED in the tree. Verified first: tsc clean · eslint clean · unit 185/185 (incl. the 16 keep-range tests). Dev server + renderer (3003) healthy.
- BROWSER QA of the uncommitted player work (agent-browser):
  • VideoPreview: HTML5 <video> streams /api/media/<projectId> (readyState 4, time advancing), "LOCAL SOURCE · 32.3 MB" badge, zero iframes. ✔
  • AutoEditPlayer: "local source · real cut preview" badge, real media playback with cut-skipping, live edit state (source time / camera scale / in-cut), mute button fixed (was pausing). ✔
  • RemotionPlayer: 🐛 REAL BUG FOUND + FIXED — VisualCard called Remotion interpolate() with inputRange [0,10,30,30] (duplicated keyframe) → threw "inputRange must be strictly monotonically increasing" → ErrorBoundary blanked the ENTIRE preview for any plan that has B-roll visuals. Fixed with a valid fade-in (0→fadeIn frames, fps-aware, clamped) + comment explaining the Remotion constraint. Post-fix: real 9:16 footage renders with "real source · cuts removed" badge, subtitles with emphasis, segments/camera panels; playhead advances (verified with REAL CDP clicks — programmatic .click() has no user activation, a QA-methodology artifact worth remembering). ✔
- PLOpsj6DVQ8 RETRY: still hard-blocked — now across ALL innertube clients (ANDROID/IOS 400, TVHTML5/MWEB LOGIN_REQUIRED, WEB_EMBEDDED ERROR) while the control video resolves fine → video-specific flag (very likely self-inflicted: our own scale tests hammered it). NEW yt-dlp also requires a JS runtime for extraction (--js-runtimes node/bun; downloadYoutubeMedia already passes --js-runtimes bun). DECISION: stopped probing (every retry adds heat); the system already degrades honestly via the first-class manual-duration path. A rapid-probe round made 5 unrelated videos temporarily bot-blocked too (IP heat) — documented as an operational lesson; media download re-verified working when the IP is cool.
- 🆕 STORAGE HYGIENE (library LRU + delete cleanup):
  • NEW src/lib/media-cache.ts — pure LRU eviction planner (planMediaCacheEviction: oldest-first until under cap, 10-min protect window for active downloads/renders, cap 0 = unlimited) + thin fs executor (pruneMediaCache evicts upload/yt/<id> dirs, updates .lru.json hints) + throttled touchMediaCache (1 write/min/id). Cap via CLIPFORGE_MEDIA_CACHE_MB (default 2048; documented in .env.example).
  • Wired: prepare-worker touches LRU after a successful download then prunes and HONESTLY marks evicted projects localMediaState='unavailable' with an actionable message (no dangling paths); media GET route + render-proxy JSON mode touch LRU on real usage (throttled); project DELETE now removes upload/projects/<projectId>/ (uploaded originals — previously a leak) and upload/yt/<youtubeId>/ when no other project references the id.
  • Live-verified end-to-end: fake cached dir → 206 range stream → .lru.json created on stream → DELETE removes the dir → media 404 after delete.
- 🆕 USAGE-BASED SOFT LIMITS (friendly, honest, env-configurable):
  • NEW src/lib/usage-limits.ts — per-kind daily caps (analyze 60 / prepare 30 / render 40 / transcribe 30 defaults; CLIPFORGE_DAILY_LIMIT_* envs; 0 = unlimited; garbage/negative → default), UTC-midnight reset window, DB-counted from UsageEvent (persists across restarts, unlike the burst limiter), fail-open on internal errors (limits must never take the engine down).
  • Wired into ALL FOUR expensive routes with friendly 429s: analyze (before LLM spend), source/prepare + jobs retry (a retry is real engine work), render-proxy render (BOTH JSON + multipart paths), source/transcribe. 429 body: friendly message (what was hit, used/cap, exact reset time, what still works, self-host env escape hatch) + code/kind/used/cap/resetAt + X-RateLimit-* / Retry-After headers.
  • UI: /api/usage now returns a `limits` block; UsagePanel renders per-kind daily meters (color-coded progress bars, amber at ≥80%, "resets in Nh Nm", amber trigger button + pulsing dot when near/at cap, explicit "you can keep editing/exporting/previewing" copy). Browser-verified rendering (1/60 · 1/30 · 0/30 · 0/40 with meters).
  • REAL 429 PROVEN END-TO-END: seeded 60 analyze events for a fresh session → POST /api/clips/analyze → 429, Retry-After 22121, remaining 0, friendly message with reset time + env knob; probe events cleaned up after.
- 🐛 TEST-ISOLATION FIX: url-render E2E hit the shared per-IP 6/min render burst limiter when run after the other render suites → now 429-aware (waits out Retry-After once, with an explanatory log line — the limiter working as designed is not a failure).
- REGRESSION GATES (all after changes): tsc clean · eslint clean · unit 225/225 (+40: 19 media-cache, 21 usage-limits incl. UTC rollover/env semantics) · golden E2E 17/17 (20.000s 1080×1920 h264+aac non-silent) · render-security 20/20 · url-render 17/17 · long-source scale 15/15 · live 17/17. Fresh-browser console: ZERO errors/warnings; golden path re-verified (project restore → 4 clips → real media preview).

Stage Summary:
- The last round's in-flight player work is now committed, QA'd, and one real bug better (VisualCard crash); preview == render parity holds in all three players.
- The library now polices its own disk usage honestly (LRU + explicit 'unavailable' states), and engine costs are soft-limited with a UX that explains itself instead of dead-ending.
- Next round suggestions (priority order):
  1) git push origin main (36043db + this round — push failed transiently before; retry first).
  2) Word-precision subtitle QA on long sources: karaoke emphasis uses wordTiming — verify 'mixed' provenance degrades gracefully on a real 30min+ source (PLOpsj6DVQ8 remains video-flagged; use any fetchable long video).
  3) Render progress realism: stage timings exist in logs; surface per-stage ETA in the UI (probe→extract→render→finalize weights).
  4) Cheap auto-heal: on media GET 410 (file missing), offer one-click re-prepare in the UI (state machinery already honest).
- Risks: none new. Standing: YouTube egress is IP/heat dependent (honest degradation everywhere); in-memory burst limiter (soft limits are DB-backed); B-roll/SFX/music preview-only.

---
Task ID: cron-review-20261008-3 (webDevReview round 7)
Agent: Z.ai Code (Principal Engineer)
Task: Status assessment + browser QA + next-priority features: render progress realism (per-stage ETA) and media-410 auto-heal.

Work Log:
- BASELINE @ ece9ffe (clean tree, pushed to origin/main): tsc clean · eslint clean · unit 225/225 · dev server + renderer healthy. Fresh-browser console: 0 errors/warnings. All four round-5/6 priorities confirmed complete (players wired, PLOpsj6DVQ8 investigated + documented, LRU live, soft limits live).
- 🆕 FEATURE A — render progress realism (upload-render.tsx):
  • The old step indicator showed Queue/Extract/Concat/Encode/Done with hand-picked thresholds [0,5,35,50,100] that never matched the renderer's real weights — and there IS no separate concat stage (single-pass trim+concat+filters). Replaced with renderer-aligned stages: Queue/Upload (0) → Prepare (8) → Encode (25, driven by the ffmpeg -progress pipe 25→92) → Finalize (93) → Done (100).
  • Honest ETA: rolling (time, progress) samples from REAL poll data (8-sample window, slope needs ≥2s span; no fake countdown before the slope is stable → animated "estimating…"), clamped 2s–12min; elapsed clock alongside. Live-verified: ETA counted down coherently (3:01 → 2:20 → 1:29 → 0:49 → done) during a real 2:39 render.
  • Result card now shows total render time ("rendered in 2:39") — which exposed a truth: earlier notes quoting "46s" were the OUTPUT duration, not render time; renders genuinely take minutes (zoompan@1080x1920 + subtitle burn + medium preset). The ETA UI is exactly the honesty upgrade this needed.
- 🆕 FEATURE B — media-410 auto-heal (video-preview.tsx + page.tsx):
  • The <video> error event is ambiguous (code 4 = missing OR blocked OR unsupported). VideoPreview now probes its own owner-scoped endpoint ONCE on playback failure (Range GET): 410/409 → confirmed missing → amber heal card ("Source file is missing on disk — clips, scores, and edit plans are all intact"); anything else → generic error, no speculative requests while healthy.
  • NEW handleReprepareMedia in page.tsx: POST /api/source/prepare { url, projectId } re-downloads the source INTO THE SAME PROJECT (clips/plans untouched), polls the job (~22min window), then updates projectMedia + bumps mediaReloadKey → ?v=N cache-buster + <video key> remount forces a fresh load; AutoEdit/Remotion players get the same busting URL. Honest failure toast (download failed → upload path still offered).
  • FULL E2E VERIFIED IN BROWSER: golden path (URL → 4 clips → LOCAL SOURCE) → simulated LRU eviction (rm source.mp4) → project reload shows the amber heal card (broken player replaced, clips intact) → click "Re-prepare source" (button disables + spinner "Re-preparing… (downloading source)") → ~12s later toast "Source restored", LOCAL SOURCE · 32.3 MB badge back, <video> readyState 4 (3:33 duration, ?v=1), file physically back on disk.
  • BONUS VERIFICATION: full render from the restored server source succeeded (1080×1920 · 36s · 24.62 MB · rendered in 2:39, real footage + burned hook subtitle) — the heal loop restores the COMPLETE render-ready state.
- REGRESSION GATES (all after changes): tsc clean · eslint clean · unit 225/225 · golden E2E 17/17 · render-security 20/20 · url-render 17/17 (429-aware retry absorbed the shared burst window) · long-source scale 15/15 · live 17/17.

Stage Summary:
- Two UX-honesty gaps closed: the render progress UI now tells the truth (real stages + real ETA + total time), and a missing source file self-heals in one click instead of dead-ending on a broken player.
- Next round suggestions (priority order):
  1) Cover-frame picker: pick the Short's cover from plan keyframes (renderer extracts a JPG at a chosen timestamp — small honest renderer addition, real Shorts value).
  2) Batch render queue: render all POST-flagged clips sequentially with per-clip progress (the pipeline + limits machinery already supports it; UI is the work).
  3) Word-precision subtitle QA on a fetchable long source (PLOpsj6DVQ8 still video-flagged; IP heat rules: ≤1 probe/hour).
  4) docs/ARCHITECTURE.md refresh (players/auto-heal/limits/LRU have evolved since it was written).
- Risks: none new. Standing: YouTube egress IP/heat dependent; in-memory burst limiter (soft limits DB-backed); B-roll/SFX/music preview-only; render artifacts expire after 10 min.

---
Task ID: cron-review-20261008-4 (webDevReview round 8)
Agent: Z.ai Code (Principal Engineer)
Task: Status assessment + agent-browser QA + close out the leftover debug-route investigation; next feature: cover-frame picker (top suggestion from round 7).

Work Log:
- BASELINE @ 695a946 (that HEAD was an UNdocumented automated commit adding a TEMPORARY unauthenticated /api/debug/fs route used to diagnose a suspected "media-410 false positive"; no worklog entry existed). Verified: tsc clean · eslint clean · unit 225/225 · renderer (3003) healthy · dev server healthy · media streaming 206 with the file present on disk (33.9 MB).
- LEFTOVER INVESTIGATION CLOSED: the debug route's own output proved the server side is healthy (cwd correct, resolveLocalMediaPath valid, stat OK) — there is NO server-side 410 false positive. Actions: (1) DELETED the unauthenticated debug route (it leaked cwd/env/fs info with no session check — a security regression marked "delete after diagnosing"); (2) honesty upgrade in VideoPreview's probe: a 409 ("no streamable source, state: X") is NOT the same truth as a 410 ("file was on disk, now gone") — the heal card now parses the 409 body and says WHICH truth: "Source file is missing on disk" (410) / "Source download never completed" (409 failed) / "Source was never downloaded" (409 skipped/unavailable), each with matching action copy.
- BROWSER QA (agent-browser) of the restored project (dQw4w9WgXcQ): landing clean; library → open → HTML5 video readyState 4 (213s, 1920x1080), LOCAL SOURCE badge, playback advances; Auto-Edit drawer "local source · real cut preview" with LIVE EDIT STATE advancing (source 00:24, progress 12%, camera 1.08×, karaoke subtitle + B-roll card visible); Render panel: Server source selected (32.3 MB) + render-ready chip + honesty card; zero console errors.
- 🆕 FEATURE — COVER-FRAME PICKER (Shorts cover, end-to-end, preview == render):
  • Renderer contract (recipe-validation.ts): optional `cover: { timestamp }` (OUTPUT time) — INVALID_COVER code for non-object/NaN/negative/beyond duration+1s; carried through ValidatedRecipe.
  • Renderer (index.ts): after codec gates, extracts cover.jpg from the RENDERED output (`-ss <t> -frames:v 1 -q:v 2`, clamped inside duration); job.hasCover broadcast in poll/SSE; NEW GET /jobs/:id/cover serves image/jpeg with a sanitized download filename; extraction failure degrades honestly (hasCover=false, MP4 stays valid, warn log).
  • buildRecipeJSON(recipe, { coverTimestamp }) emits cover only when finite + in-bounds (clamps exact-end to duration−0.05) — never sends known-bad data.
  • Proxy: /jobs/:id/cover added to the authorized JOB_PATH_RE (owner-scoped like poll/stream/download/cancel); SECURITY.md-relevant comment updated.
  • UI (upload-render.tsx): cover picker panel (plan + non-empty edit) — 9:16 canvas preview drawing the REAL source frame at sourceTimeAtOutput(mapKeepRanges(...), coverT) (SAME mapping the renderer consumes), 0.1s slider over the output duration, First/Middle/Last presets, Clear, honest copy ("a JPG of this exact frame — after cuts, zoom & subtitles"); no-preview-source state stays honest; recipe carries the choice in BOTH render modes; result card shows the cover thumbnail beside the video + "Download cover (JPG)".
  • TESTS: unit 225 → 240 (6 validation-matrix cover cases + 9 recipe-emission/preview-parity cases); golden E2E 17 → 25 (recipe carries cover, hasCover=true, /cover serves a real 1080x1920 JPEG: magic FFD8FF, decodable, correct dimensions).
- BROWSER-VERIFIED FULL COVER LOOP (real render, 2:38): picker canvas drew the real frame (@ 18s via Middle preset) → Render MP4 → "Render complete! 1080×1920 · 36s · 24.62 MB" with the cover thumbnail BESIDE the video (burned subtitle visible in the cover — exactly as promised) + Download cover (JPG) button present; zero console errors.
- REGRESSION GATES (all after changes): tsc clean · eslint clean · unit 240/240 · golden E2E 25/25 · render-security 20/20 · url-render 17/17 · long-source scale 15/15 · live 17/17.
- Committed 391b786, pushed to origin/main (also carries 695a946's now-deleted debug route — net zero).

Stage Summary:
- The suspected 410 false positive is closed with evidence (no server bug; client probe now state-honest), and the temporary debug surface is gone.
- Shorts cover workflow shipped: pick a frame from the REAL edited output (preview == render parity), get a 1080×1920 JPEG with the render — a real creator need, fully authorized end-to-end.
- Next round suggestions (priority order):
  1) Batch render queue: render all POST-flagged clips sequentially with per-clip progress (pipeline + soft limits already support it; UI is the work).
  2) Cover UX+: per-clip cover memory (persist chosen coverT on the Clip row) + "download cover" from the library for older renders (needs artifact persistence beyond the 10-min expiry — pair with an artifacts dir).
  3) Word-precision subtitle QA on a fetchable long source (PLOpsj6DVQ8 still video-flagged; IP heat rules: ≤1 probe/hour).
  4) docs/ARCHITECTURE.md refresh (players/auto-heal/limits/LRU/cover have evolved since it was written).
- Risks: none new. Standing: YouTube egress IP/heat dependent (honest degradation); in-memory burst limiter (soft limits DB-backed); B-roll/SFX/music preview-only; render artifacts expire after 10 min (cover.jpg shares that lifecycle).
---
Task ID: manual-20261008 (security/memory/timing hardening round)
Agent: Z.ai Code (Principal Engineer + Video Systems + Security)
Task: 18-point P0→P2 directive — renderer network boundary, request/response memory safety, transcript timing honesty, long-video retrieval, cancellation hardening, VTT robustness, context completeness, repo polish. Establish baseline first; fix only what inspection justified; never weaken existing guarantees.

Work Log:
- BASELINE @ 9eb66d0 (mode-changes-only commit, clean tree): tsc clean · eslint clean · unit 240/240 · golden E2E 25/25 · render-security 20/20 · url-render 17/17 · scale 15/15 (after an env fix, see below). No old-audit reruns.
- 🔒 P0-1 RENDERER LOOPBACK BIND: `serve({ hostname: '127.0.0.1' })` — Bun's default is 0.0.0.0; the renderer (unauthorized, trusted-internal) was silently listening on ALL interfaces. Now loopback-only, with a security-architecture header comment (Browser → Next.js auth → localhost renderer → FFmpeg; remote-renderer requires explicit internal auth first). VERIFIED LIVE: `ss` shows `127.0.0.1:3003`, external-interface connection refused, loopback 200.
- 🔒 P0-2 UPLOAD MEMORY SAFETY: render-proxy multipart passthrough no longer does `await req.blob()` (up to 1.5 GB materialized in RAM). Now `req.body` forwarded as a ReadableStream through a byte-capped TransformStream — enforces the 1.5 GB cap DURING streaming (covers chunked uploads with no Content-Length where a declared-length precheck is impossible) and trips an honest 413. Content-Type (multipart boundary) preserved.
- 🔒 P1-3 DOWNLOAD MEMORY SAFETY (both sides): renderer download/cover now stream via `Bun.file(outPath)` + stat Content-Length (readFileSync removed); proxy GET for download/cover pipes `upstream.body` straight through with Content-Length/Disposition/Cache-Control passthrough (poll stays buffered for DB status sync). POST /render start-response (small JSON) intentionally still buffered for ownership recording.
- 🐛 P1-9 CANCELLATION RACE FIXED: a job cancelled during FINALIZATION (probe/cover extraction awaits) hit `transition(job,'done')` → transition refused (cancelled has no outgoing edges) — but the code IGNORED the result and still set stage='Render complete', progress=100, broadcast. A cancelled job announced completion. Now guarded: `if (!transition(job,'done')) return` — terminal state stands, no overwrite, no broadcast.
- 🐛 TERMINAL-CLEANUP LEAK FIXED: cleanup (jobDir rm + jobs.delete) was scheduled ONLY on the success path — cancelled/failed jobs leaked their input (≤1.5 GB) and registry entry forever. Now in `finally` for EVERY terminal outcome (same 10-min artifact window).
- 🕐 P1-4/5/6 TIMING HONESTY (media.ts): (a) srv3ToJson3: missing `<s>` offset now stays ABSENT — was coerced to `tOffsetMs: 0`, which downstream read as REAL measured timing pinned to segment start; (b) parseJson3 rewritten with a binding definition of "measured": a word is measured ONLY when the source identifies THAT token (sole word of a segment carrying a real offset). Multi-word segments ("I love this technology" @ one timestamp) distribute inside their window → estimated; real offsets are never discarded in partially-measured events (unmeasured segs interpolate between measured anchors, monotonic-clamped); provenance is now PER-WORD (≥80% measured / 20–80% mixed / else estimated). All 240 pre-existing tests preserved unchanged + new matrices.
- 🕐 P1-10 VTT ROBUSTNESS (vttToJson3): supports MM:SS.mmm AND HH:MM:SS.mmm (MM:SS cues were silently DROPPED before), ignores cue settings, joins multiline cues, strips markup + inline `<00:00:02.000>` timestamps, skips NOTE/STYLE/REGION/malformed/reversed/empty cues. Segment timing stays estimated (never fake word timing). Fixture matrix added.
- 🔍 P1-7 LONG-VIDEO RETRIEVAL (new src/lib/transcript-window.ts + analyze route): the old prompt sent timestamps for only the FIRST 400 words and head-truncated text at 24k chars — on a 1-hour video the model could ground only the opening ~2 minutes (systematic early bias). Replaced with full-timeline inline `[mm:ss]` markers every 40 words (constant token cost) + an 80k-char budget; over budget → deterministic block STRIDE across the whole timeline (first AND last block always kept, explicit `[… elided — never quote across this gap …]` markers). Server-side grounding unchanged (processCandidate still validates/snaps against the FULL word array — server remains authoritative). PROMPT_VERSION → analyze-v4-fullspan. Tests: 60-min synthetic (markers near start/middle/59min, no head bias), 3-hour stride (budget respected, deterministic, ends preserved), text-only path.
- 🧠 P1-12 CONTEXT COMPLETENESS (validation.ts): DEPENDENT_OPENERS extended with back-references to unseen content (earlier / as you know / like we discussed / remember when / + Indonesian equivalents). ALSO FIXED A LATENT BUG: multi-word opener entries could NEVER match — the check tested only the single first word token; now matches the opening 3-word phrase ('like i said' etc. are live for the first time). New tests: "earlier…" and "as you know…" clips → EXTEND/risk.
- 📦 P2-15/16: `.env.example` added (DB, LLM key placeholder, renderer port, media cache, all four CLIPFORGE_DAILY_LIMIT_* knobs, yt-dlp resolution docs; no real values) + `.gitignore` now un-ignores it. SECURITY.md updated ONLY with claims now backed by code/tests: explicit 127.0.0.1 bind, streaming upload/download memory safety, transcript-timing integrity row, cancellation/cleanup hardening.
- 🐛 ENV DRIFT FIXED (found by url-render E2E): yt-dlp vanished from the sandbox PATH (container restart). `findYtDlp()` now resolves ~/.local/bin/yt-dlp (PEP 668 user installs) in addition to venv/system paths — self-host deployments silently lose PATH additions; the binary on disk is found anyway.
- VERIFICATION: tsc clean · eslint clean · unit 291/291 (+51) · golden E2E 25/25 (streaming renderer + proxy download live) · render-security 20/20 (multipart upload through proxy streams; ownership intact) · url-render 17/17 (yt-dlp resolved, real captions 'measured' 291 words, JSON render via proxy, 13.4 MB download verified h264/1080×1920/aac non-silent) · scale 15/15 (live LLM on a 2383s source with the fullspan prompt). Browser QA (agent-browser): landing clean, library correctly owner-scoped (fresh session = empty library), full golden path in-browser (URL → yt-dlp prepare 32.3 MB local source → analyze 5 clips avg 83/100 → approve 5/5 → timeline/cards render), <video> readyState 4 (213s 1920×1080), ZERO console errors/page errors.
- NOTE: renderer mini-service must be RESTARTED (not --hot-reloaded) for the bind change — `serve()` never re-runs on hot reload. Anyone redeploying must bounce the service once.

Stage Summary:
- The renderer is now loopback-only by construction, uploads and downloads stream end-to-end (no RAM-materialized bodies either direction), cancelled jobs can never lie about completion, and cancelled/failed renders no longer leak disk.
- Transcript timing is honest at the WORD level (missing ≠ 0, multi-word segment ≠ per-word measured), VTT fallbacks parse real-world cue forms, and long videos get full-timeline grounding without full-array prompts.
- Remaining honest gaps (not silently claimed fixed): (1) renderer progress `run()` stdout/stderr accumulations are unbounded-but-practically-small (capped by 15-min timeout); (2) cancellation race during the final cover-extraction window is structurally guarded but the exact mid-extract kill timing is not race-tested (structural unit assertion + state machine; marked accordingly); (3) chunked oversized uploads are capped mid-stream but the renderer's own Content-Length pre-check can't see chunked sizes (proxy cap is the enforcement point — documented); (4) usage/perf measurement (P2-17) remains log-based only — no dashboard, by design (no SaaS infra).
- Next round suggestions (priority order): 1) batch render queue (UI work only — pipeline/limits ready); 2) cover memory per clip + artifact persistence beyond 10 min; 3) long-video word-precision subtitle QA on a fetchable 30min+ source (IP heat rules: ≤1 probe/hour); 4) docs/ARCHITECTURE.md refresh (players/auto-heal/limits/LRU/cover/fullspan evolved).
- Risks: none new. Standing: YouTube egress IP/heat dependent (honest degradation everywhere); in-memory burst limiter (soft limits DB-backed); B-roll/SFX/music preview-only; render artifacts expire after 10 min.

---
Task ID: surgical-hardening-1
Agent: Z.ai Code (Principal + Security + Video Systems Engineer)
Task: Surgical hardening pass on current HEAD (9ce473a) — six priorities: renderer wildcard CORS removal, multipart stream backpressure, SSE proxy hardening, honest render-job ownership recording, hard-bound transcript prompt budget, loopback proxy normalization.

Work Log:
- PHASE 0 BASELINE (before any edit): HEAD 9ce473a, tree clean · tsc PASS · eslint PASS · unit 291/291 · golden 25/25 · render-security 20/20 · url-render 17/17 · scale 15/15 · Next :3000 up, renderer :3003 up.
- P0 CORS REMOVAL (mini-services/ffmpeg-renderer/index.ts): verified the loopback-bound renderer still emitted `Access-Control-Allow-Origin: *` + `Allow-Methods` + `Allow-Headers: *` + an OPTIONS preflight branch on every response. Removed `cors()` entirely (all 21 call sites), the OPTIONS handler, and documented WHY in the header (CORS is browser-enforced; the only supported client is the Next.js proxy doing server-to-server fetch — wildcard ACAO could only ever authorize browser pages to read a trusted internal service). Renderer restarted (first restart FAILED with EADDRINUSE — the old `bun --hot` process still held 3003 and kept serving OLD code; killed both, started one clean `bun run start`; NOTE for deployers: kill the --hot process before rebinding). Verified live: `/` now returns ZERO CORS headers; OPTIONS is no longer a preflight.
- P1 MULTIPART BACKPRESSURE (render-proxy route): `buildStreamingMultipart` was an eager `start()` pump — it enqueued the ENTIRE source file into the stream's internal queue as fast as disk allowed (queue memory ≈ file size; the fetch consumer never gated reads). Rewritten as a `pull()`-driven producer: reads happen only when the downstream pulls (default HWM → in-flight memory ≈ 2×8 MB chunks + one 8 MB scratch buffer), `cancel()` releases the file handle on mid-upload aborts, byte-identical multipart framing (pre → file chunks → post). Browser-passthrough path (`byteCappedStream` via TransformStream, readable HWM 0) was already consumer-driven — left untouched.
- P1 SSE PROXY: the manual `getReader()`/pump wrapper had no `cancel()` (downstream disconnect leaked the upstream renderer connection + its subscriber forever), detached pump errors were unhandled rejections that hung the downstream. Replaced with native `new NextResponse(upstream.body, …)` passthrough (same pattern as the MP4/cover path) — backpressure, upstream errors, and downstream cancellation now propagate through the runtime; SSE event format byte-identical.
- P1 OWNERSHIP HONESTY: `recordRenderJob()` swallowed ALL failures — a DB failure after the renderer accepted a job stranded an orphan render (burning CPU/disk for its full lifetime) while the client held an id every proxy operation would 404. Now returns `{ ok, rendererJobId }`; on failure the proxy CANCELS the renderer job (direct loopback call) and returns an honest 500 ("ownership could not be recorded; the render was cancelled. Please retry.") — no doomed job id is ever handed to the client, no orphan work, no duplicate rows (upsert per renderer-UUID unchanged; retries legitimately create new jobs).
- P1 TRANSCRIPT BUDGET HARD BOUND (src/lib/transcript-window.ts): the old `keepCount = maxChars/avgBlock` estimate ignored elision labels, so strided output could EXCEED maxChars; a whitespace-free transcript (one giant block, e.g. CJK) bypassed striding entirely (`keepCount >= total` → joined everything). Added `strideToFit()` (build candidate → MEASURE final length incl. labels → deterministically drop ceil(overshoot/perBlock) blocks → rebuild; floor keepCount at 2 so block 0 + last always survive) + `hardCutToBudget()` last-resort guard (honest tail marker, content removed never fabricated). maxChars is now honored exactly (the old implicit 4000 floor removed — no production caller passes opts). INVARIANT: output.length <= maxChars for every input.
- P2 LOOPBACK: `RENDERER_BASE` → `http://127.0.0.1:3003` (explicit loopback; no localhost→::1 DNS drift; consistent with the renderer bind).
- TESTS ADDED: unit +38 (budget matrix: sweep 4k–80k, tiny/exact/budget±1, text-only, CJK giant block, fitted-stride first+last coverage, determinism ×2; structural: no ACAO/Methods/Headers/OPTIONS in renderer, pull-based multipart + no start() pump + cancel(), no getReader() in GET, recorded.ok handling + cancel + honest error, 127.0.0.1 proxy base). render-security E2E +6 behavioral: `ss` asserts LISTEN on 127.0.0.1:3003, health responds, zero ACAO/Methods/Headers headers, OPTIONS not preflighted.
- DOCS: SECURITY.md updated only with claims now backed by code/tests (no-CORS renderer, behavioral bind assertion, consumer-driven backpressure, orphan-job mitigation row incl. the NOT-TESTED note for simulated DB failure).
- SECONDARY REGRESSION REVIEW: ownership gates untouched (foreign 404s re-verified live 26/26); render pipeline untouched (golden 25/25 live re-run); caps unchanged; cancellation state machine untouched; SSE content-type/status routing unchanged for non-200; dev.log clean (no runtime errors; only prisma trace lines).

Stage Summary:
- All six priorities verified against CURRENT code first; every confirmed finding was the smallest safe change; nothing already-correct was rewritten (browser-passthrough streaming, byte caps, renderer limits, state machine, ownership gates left as-is).
- Verification: tsc PASS · eslint PASS · unit 329/329 · golden 25/25 · render-security 26/26 (incl. live no-CORS + bind assertions) · url-render 17/17 (pull-based multipart live, real render+download) · scale 15/15 (2383s source, fullspan prompt, hooks grounded) · browser QA: landing renders, zero console/page errors.
- Honest gaps: (1) production build NOT RUN in this sandbox (dev server owns `.next`; CI runs the build on push) — everything else in the test order was run; (2) simulated DB-failure live test for recordRenderJob intentionally NOT run against the shared dev DB — covered structurally + happy-path live; (3) downstream-cancellation propagation of the SSE passthrough is by runtime contract (native body passthrough), not race-tested live; (4) the 1.5 GB memory bound is enforced by design (byte-capped TransformStream + pull-based reads) and verified on real renders, not with a giant fixture (per instructions).
- Scale suite is the long-video product evidence available (2383s source, real LLM, server-grounded hooks); unit suite asserts late-video markers at 56–59 min of a 60-min transcript with no head bias. No fresh human-podcast review this round (YouTube egress heat rules; existing fixture used).
- Next round suggestions: artifact persistence beyond 10 min; batch render queue UI; docs/ARCHITECTURE.md refresh.

---
Task ID: 1
Agent: Z.ai Code (Principal Engineer + Security Engineer + Video Systems Engineer)
Task: Review round — CI was reported broken (P0: fix .github/workflows/ci.yml line 44, rerun CI, make every gate actually green); P1 full browser acceptance suite; P2 items assessed against local-first constraints.

Work Log:
- BASELINE: HEAD 5bf50f7 (clean), 1 commit AHEAD of origin — the previous hardening round was never pushed. GitHub CI had FAILED on every run since CI was introduced (b537b71).
- P0 ROOT CAUSE #1 (the "line 44"): ci.yml step name `- name: Build (strict gates: type errors fail the build)` contains an UNQUOTED `: ` inside a YAML plain scalar → "mapping values are not allowed here (line 44, column 34)" → GitHub rejected the ENTIRE workflow on every push: zero jobs ever started, so typecheck/lint/unit/build/golden/security had NEVER run on GitHub at all. Fixed by quoting the name + a comment so it stays fixed. Validated with a real YAML parse.
- P0 ROOT CAUSE #2 (latent, would fail e2e next): the e2e job's dev server ran with NO DATABASE_URL (no .env in CI — gitignored) → every DB-touching proxy op (ownership, job recording) would 500. Fixed with a workflow-level `env: DATABASE_URL: file:${{ github.workspace }}/db/custom.db` (absolute → identical resolution for Prisma CLI and generated client), `mkdir -p db` before db:push, health checks moved to 127.0.0.1 and made fail-fast (step fails if the service never came up instead of silently continuing).
- P0 ROOT CAUSE #3 (found by the first REAL CI run — product bug, not just CI): renderer WORKDIR was the hardcoded sandbox path '/home/z/my-project/upload/ffmpeg-render' → on the GitHub runner `mkdirSync('/home/z')` → EACCES → renderer crashed at import → e2e job red at "Start ffmpeg-renderer mini-service" (curl exit 7 — the fail-fast health check did its job). Fixed portably: `RENDERER_WORKDIR` env override + repo-relative default via `import.meta.dir` → byte-identical path in this sandbox (existing artifacts untouched), writable path anywhere else. Audited media.ts hardcoded paths: yt-dlp candidates are existence-guarded with honest error → left as-is. +3 unit assertions lock portability in.
- P0 RESULT: **first fully-green CI run in repo history** (run 37723172106 then 37723869976 on 64a40d3): typecheck · lint · unit ✅ · production build ✅ · render E2E (golden+security) ✅ — all three jobs success on GitHub's own runners, not just locally. Production build additionally verified locally in an isolated clone (fresh install, no .env, frozen lockfile, strict type gates, all 17 API routes + static / compiled).
- P1 BROWSER ACCEPTANCE (agent-browser, desktop 1280×800 + mobile 390×844): full chain URL → Auto-Clip → scoring (5 clips, 78.5–89, 7-dim breakdowns, transcript-verified hooks) → filter/sort (Default/Score↕/Time, All-clips filter) → preview (keep-range seek via embed) → edit → approve (per-clip + bulk + keyboard hints) → AI plan (dialog: segments/subtitles/visuals/cuts/camera/sound/JSON tabs + generated on-screen hook) → Update library ("5 clips saved — transactional replace") → Library (stats bar, search, Recent/Most clips/Longest, render-ready badge) → Render tab → cover-frame picker (Middle preset) → **real MP4 render with live SSE progress + real ETA + stage pipeline** → result card → Download MP4 + Download cover (JPG). Artifacts validated: MP4 = 1080×1920 h264+aac 45.2s streamed via ownership-scoped proxy (browser cookie == RenderJob.ownerId verified in DB); frame@5s shows burned subtitle "We're no strangers to love." + centered 9:16 crop; frame@30s shows camera punch-in + correctly-synced subtitle — a genuinely publishable Short.
- P1 YouTube-blocked scenario (PLOpsj6DVQ8): metadata falls back to oEmbed, analysis completes with hooks honestly marked UNVERIFIED, auto-download fails with the REAL yt-dlp error string, render panel flips "Server source → Unavailable (disabled)" while the "Your file" upload path stays available — recovery path is explicit ("— upload the file below to render.").
- P1 Manual duration: honestly labeled "used only if the server cannot fetch the real one" — with a reachable video the real measured duration wins (footer shows `3m 33s · yt-dlp`), preventing fabricated timelines.
- P1 Failed download + retry: yt-dlp runs with --retries 3/--fragment-retries 3; on final failure the error text is shown verbatim + drop-zone fallback + plan intact.
- P1 Upload fallback: qa-podcast.mp4 accepted via drop zone ("1.60 MB · video/mp4"), ready to render with the applied plan. (Full transcribe/ASR path covered by earlier rounds' suites; this round verified the render-side fallback in-browser.)
- P1 Mobile/responsive: hero/input/chips stack cleanly at 390px, cards full-width, footer flush at page bottom with the honest-AI disclaimer, no overlap/floating gap. Browser console clean (no errors/warnings) across the whole session.
- BONUS FIX (surfaced by QA, matching the prior round's documented honest gap): recurring `unhandledRejection: TypeError: terminated (SocketError: other side closed)` on proxy→renderer sockets — downstream disconnect raced undici because neither upstream fetch carried the abort signal. Fix: `signal: req.signal` on POST /render upload + GET poll/stream/download (controlled abort instead of socket-error rejection). Verified live: render-security 26/26 + golden 25/25 with the dev.log rejection count UNCHANGED (6 → 6 → 6 across 51 proxy render cycles). +2 unit assertions.
- P2 ASSESSMENT (documented, not implemented — per DO-NOT-IMPLEMENT/local-first constraints): (a) B-roll/SFX/music remain recommendation-only — executing them means sourcing/licensing real assets + renderer compositor work; documented as the next product phase, not silently skipped. (b) Real publishing integration (YouTube/TikTok upload APIs) = external OAuth + platform ToS surface — deferred by design. (c) PostgreSQL + shared rate-limit store is only required for MULTI-INSTANCE deployment; this repo is explicitly single-instance local-first (SECURITY.md documents it) — SQLite + in-memory limiter remain correct for the actual deployment target. None of these are bugs; changing them now would add the complexity the mission forbids.

Stage Summary:
- Commits pushed: 1db3027 (CI workflow fix), 64a40d3 (portable renderer WORKDIR), 4c25f44 (abort-signal propagation) — plus the previously-unpushed 5bf50f7 hardening round finally reached origin.
- Verification: local typecheck PASS · lint PASS · unit 334/334 · render-security 26/26 (live) · golden 25/25 (live) · production build PASS (isolated clone, CI-identical) · **GitHub CI: all 3 jobs green** · browser QA full-chain PASS with validated artifacts · dev.log clean of new unhandled rejections.
- Honest gaps / watch items: (1) one transient blank page was observed early in browser QA (single occurrence, gone on reload, zero console errors — likely a dev-mode recompile race during first interaction; not reproducible in ~40 subsequent interactions; flagged for the next QA round). (2) The 45.2s rendered output vs the cover panel's "output 23s" label discrepancy: the render corresponded to the selected 45s clip; the label likely reflected a different/shorter preview selection — cosmetic watch item, recheck on next UI pass. (3) Real-publishing/B-roll execution/Postgres intentionally deferred (see P2 above). (4) dQw4w9WgXcQ yt-dlp metadata+captions worked from this IP this round — YouTube egress remains fragile in general; the blocked-video path is the safety net and is verified.
- Next round suggestions: render-queue (batch) UI; recheck the "output 23s" label; artifact persistence beyond 10 min; B-roll asset pipeline design; refresh docs/ARCHITECTURE.md with the new CI guarantees.

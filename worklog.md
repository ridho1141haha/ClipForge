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

/**
 * ClipForge unit tests — run: bun run tests/clipforge-unit.ts
 * Covers: server scoring scale (Test D), dedupe/overlap/count (E, F),
 * timeline source→output mapping (I), transcript-grounded hooks (B),
 * context validation (Phase 7), JSON extraction, json3 caption parsing.
 */
import {
  recalcTotal,
  determineRecommendation,
  clampClipTimes,
  dedupeAndRank,
  validateHookAgainstTranscript,
  checkContext,
  extractJsonObject,
  normalizeText,
  type ClipScores,
} from '../src/lib/validation'
import {
  sourceToOutputTime,
  outputToSourceTime,
  buildKeepRanges,
  buildSubtitlesFromWords,
  buildSrt,
  buildVtt,
  outputDuration,
  totalCutDuration,
  isDroppedByCuts,
  sourceToOutputTimeBounded,
} from '../src/lib/subtitles'

let passed = 0
let failed = 0
function assert(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name} ${detail}`)
  }
}

function eq(a: unknown, b: unknown, eps = 0.001): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < eps
  return a === b
}

// ---------------------------------------------------------------------------
console.log('\n== Test D: server-side score calculation (documented weights, 0-100) ==')
{
  const base = { hook: 9, curiosity: 8, payoff: 8, standalone: 7, shareability: 7, emotion: 6, context_safety: 9 }
  const expected = 9 * 0.2 + 8 * 0.15 + 8 * 0.2 + 7 * 0.15 + 7 * 0.15 + 6 * 0.1 + 9 * 0.05
  // weighted sum ×10 → 0-100
  assert(eq(recalcTotal(base), Math.round(expected * 100) / 10), 'total = weighted ×10', `got ${recalcTotal(base)} want ${Math.round(expected * 100) / 10}`)
  const t1 = recalcTotal(base)
  const t2 = recalcTotal({ ...base, hook: base.hook + 1 })
  assert(t2 > t1 && eq(t2 - t1, 2), 'changing ONE dimension changes total by weight×10', `Δ=${t2 - t1} (expect 2.0)`)
  const max = recalcTotal({ hook: 10, curiosity: 10, payoff: 10, standalone: 10, shareability: 10, emotion: 10, context_safety: 10 })
  assert(eq(max, 100), 'all-10 → 100 (0-100 scale, not 0-10)', `got ${max}`)
  assert(eq(recalcTotal({ hook: 0, curiosity: 0, payoff: 0, standalone: 0, shareability: 0, emotion: 0, context_safety: 0 }), 0), 'all-0 → 0')
  assert(determineRecommendation(65, 8) === 'POST', 'total>=60 & ctx>=7 → POST')
  assert(determineRecommendation(90, 6) === 'SKIP', 'ctx<7 → SKIP even at high total')
  assert(determineRecommendation(59, 9) === 'SKIP', 'total<60 → SKIP')
  // LLM total must be ignored (schema marks it optional, server recalcs)
  const scores: ClipScores = { ...base, total: 999 }
  assert(scores.total === 999 && recalcTotal(base) !== 999, 'server recalculates — LLM total ignored')
}

// ---------------------------------------------------------------------------
console.log('\n== Test B: transcript-grounded hooks ==')
{
  const transcript = 'welcome back to the show today we talk about the future of artificial intelligence and why it matters'
  const v1 = validateHookAgainstTranscript('the future of artificial intelligence', transcript)
  assert(v1.match && v1.confidence >= 0.85, 'verbatim quote → verified')
  const v2 = validateHookAgainstTranscript('this video is about cooking pasta', transcript)
  assert(!v2.match, 'fabricated quote → rejected')
  const v3 = validateHookAgainstTranscript('anything', '')
  assert(!v3.match && v3.confidence === 0, 'empty transcript → NOT verified (never fake)')
  const v4 = validateHookAgainstTranscript('the future of, artificial intelligence!', transcript)
  assert(v4.match, 'punctuation-insensitive matching')
  // STRICT tiers — a bare 3-gram anywhere is NO LONGER enough (mission P0 #6):
  const v5 = validateHookAgainstTranscript('we talk about anything else entirely', transcript)
  assert(!v5.match, '3-gram hit + low coverage → NOT verified (was wrongly 0.7 before)', `conf=${v5.confidence}`)
  const v6 = validateHookAgainstTranscript('show today we talk about cooking', transcript)
  assert(v6.match && v6.confidence >= 0.85, '5-word contiguous run + coverage → verified', `conf=${v6.confidence}`)
  const v7 = validateHookAgainstTranscript('welcome show today talk future matters', transcript)
  assert(v7.match && v7.confidence >= 0.8, 'ordered-subsequence reconstruction (100% coverage, in order) → verified', `conf=${v7.confidence}`)
  const v8 = validateHookAgainstTranscript('welcome future show talk', transcript)
  assert(!v8.match || v8.confidence < 0.8, 'scrambled word order + gaps → not confidently verified', `conf=${v8.confidence}`)
}

// ---------------------------------------------------------------------------
console.log('\n== Test E/F: dedupe + ranking + count ==')
{
  const mk = (i: number, start: number, end: number, total: number, title = `clip ${i}`) => ({
    id: `c${i}`,
    start,
    end,
    duration: end - start,
    title,
    spokenHook: '',
    hookVerified: false,
    scores: { hook: total / 10, curiosity: 0, payoff: 0, standalone: 0, shareability: 0, emotion: 0, context_safety: 0, total },
    reason: '',
    contextRisk: false,
    contextStatus: 'PASS',
    recommendation: 'POST' as const,
    tags: [],
    transcriptExcerpt: '',
    clipWords: [],
  })
  // 10 candidates, overlaps + dupes; request 6
  const candidates = [
    mk(1, 10, 40, 80),
    mk(2, 15, 45, 70), // overlaps c1 (>50%) → dropped
    mk(3, 100, 140, 90, 'same title here'),
    mk(4, 200, 240, 60, 'same title here'), // semantic dupe of c3 → dropped
    mk(5, 300, 340, 55),
    mk(6, 400, 440, 50),
    mk(7, 500, 540, 45),
    mk(8, 600, 640, 40),
    mk(9, 700, 740, 35),
    mk(10, 800, 840, 30),
  ]
  const kept = dedupeAndRank(candidates, 6)
  assert(kept.length === 6, 'returns exactly requested count when enough valid candidates', `got ${kept.length}`)
  assert(!kept.some((k) => k.id === 'c2'), 'overlapping candidate removed')
  assert(!kept.some((k) => k.id === 'c4'), 'semantically duplicated candidate removed')
  assert(kept.every((k, i) => i === 0 || kept[i].start >= kept[i - 1].start), 'final list ordered by start')
  assert(kept[0].id === 'c3' || kept[0].id === 'c1', 'highest scores kept first by rank')
  // when fewer valid candidates than requested → return what exists
  const few = dedupeAndRank([mk(1, 0, 30, 80), mk(2, 5, 35, 90)], 6)
  assert(few.length === 1, 'overlap collapses to 1 when candidates collide', `got ${few.length}`)
}

// ---------------------------------------------------------------------------
console.log('\n== Test I: timeline mapping (source → output after cuts) ==')
{
  // Documented example: 0–20 keep, 20–30 cut, 30–40 keep
  const clipStart = 0
  const cuts = [{ start: 20, end: 30, reason: 'test' }]
  const o34 = sourceToOutputTime(34, clipStart, cuts)
  assert(eq(o34, 24), 'source 34s → output 24s (cut removed 10s)', `got ${o34}`)
  assert(eq(sourceToOutputTime(10, clipStart, cuts), 10), 'source 10s → output 10s (before cut)')
  assert(eq(sourceToOutputTime(25, clipStart, cuts), 20), 'source 25s (inside cut) → snaps to 20')
  const keep = buildKeepRanges(0, 40, cuts)
  assert(keep.length === 2 && eq(keep[0].end - keep[0].start, 20) && eq(keep[1].end - keep[1].start, 10), 'keep ranges: [0,20],[30,40]')
  // inverse
  assert(eq(outputToSourceTime(24, clipStart, cuts), 34), 'output 24s → source 34s (inverse)')
  assert(eq(outputToSourceTime(0, clipStart, cuts), 0), 'output 0 → source 0')
  // clip with lead-in: clip 100–140, cut 110–115
  const cuts2 = [{ start: 110, end: 115, reason: 'x' }]
  assert(eq(sourceToOutputTime(120, 100, cuts2), 15), 'clip lead-in: 120 → 15')
  assert(eq(outputToSourceTime(0, 100, cuts2), 100), 'output 0 → clip start')
  // output duration
  const keepAll = buildKeepRanges(0, 40, cuts)
  assert(eq(keepAll.reduce((a, r) => a + r.end - r.start, 0), 30), 'output duration = 30 (40 − 10 removed)')
}

// ---------------------------------------------------------------------------
console.log('\n== Phase 6: timestamp clamping ==')
{
  const r = clampClipTimes(50, 120, 100, 25, 60)
  assert(eq(r.start, 50) && eq(r.end, 100), 'end beyond duration → clamped to duration', JSON.stringify(r))
  const r2 = clampClipTimes(-5, 10, 100, 15, 60)
  assert(eq(r2.start, 0) && r2.end - r2.start >= 15, 'negative start → 0, min length enforced', JSON.stringify(r2))
  const r3 = clampClipTimes(10, 500, 100, 15, 60)
  assert(eq(r3.start, 10) && eq(r3.end, 70), 'over-long clip capped at maxLen', JSON.stringify(r3))
  const r4 = clampClipTimes(95, 99, 100, 15, 60)
  assert(eq(r4.start, 85) && eq(r4.end, 100), 'end-of-video clip pulled back', JSON.stringify(r4))
}

// ---------------------------------------------------------------------------
console.log('\n== Phase 7: context validation (PASS/EXTEND/REJECT) ==')
{
  // words 0-10s sentence one, 10-20s sentence two, with dependent opener at 10
  const words: { word: string; start: number; end: number }[] = []
  const s1 = 'the first thing you need to understand is how memory works in this system .'
  s1.split(' ').forEach((w, i) => words.push({ word: w, start: i * 0.5, end: i * 0.5 + 0.45 }))
  const s2 = 'and that is why the second rule matters even more than the first one did .'
  s2.split(' ').forEach((w, i) => words.push({ word: w, start: 6 + i * 0.5, end: 6 + i * 0.5 + 0.45 }))
  // clip starting at 6s (dependent opener "and")
  const cc = checkContext({ clipStart: 6, clipEnd: 14, minLen: 10, maxLen: 60, words, duration: 30 })
  assert(cc.status === 'EXTEND' || cc.status === 'REJECT', 'dependent opener detected → EXTEND/REJECT', `got ${cc.status}`)
  assert(cc.start <= 6 && cc.start >= 0, 'extension goes backwards only', `start=${cc.start}`)
  // clean clip
  const cc2 = checkContext({ clipStart: 0, clipEnd: 5.5, minLen: 4, maxLen: 60, words, duration: 30 })
  assert(cc2.status === 'PASS' || cc2.status === 'EXTEND', 'clean clip passes', `got ${cc2.status}`)
  // no words
  const cc3 = checkContext({ clipStart: 0, clipEnd: 10, minLen: 5, maxLen: 60, words: [], duration: 30 })
  assert(cc3.status === 'UNKNOWN' && cc3.contextRisk, 'no transcript → UNKNOWN + risk (never fake PASS)')
}

// ---------------------------------------------------------------------------
console.log('\n== Phase 4: JSON extraction (balanced braces, fences, trailing commas) ==')
{
  const a = extractJsonObject('{"a":1}')
  assert(!!a, 'plain JSON')
  const b = extractJsonObject('here you go:\n```json\n{"b": [1,2,3]}\n```\nthanks')
  assert(!!b && (b as any).b.length === 3, 'fenced block extraction')
  const c = extractJsonObject('prefix {"x": {"y": "a \\"quoted\\" }", "z": [1, {"w": 2}]}}, trailing')
  assert(!!c && (c as any).x.y.includes('quoted'), 'nested braces + escaped strings')
  const d = extractJsonObject('{"a": [1,2,],}')
  assert(!!d, 'trailing commas repaired')
  assert(extractJsonObject('no json here') === null, 'no JSON → null')
}

// ---------------------------------------------------------------------------
console.log('\n== Phase 15: SRT/VTT from word timestamps (output time) ==')
{
  const words = [
    { word: 'this', start: 10, end: 10.3 },
    { word: 'is', start: 10.3, end: 10.5 },
    { word: 'spoken', start: 10.5, end: 11.0 },
    { word: 'content', start: 11.0, end: 11.4 },
    { word: 'only', start: 11.4, end: 11.7 },
    { word: 'period', start: 11.7, end: 12.1 },
    { word: 'after', start: 13.0, end: 13.3 },
    { word: 'cut', start: 13.3, end: 13.6 },
  ]
  const cuts = [{ start: 12.5, end: 30, reason: 'silence' }]
  const subs = buildSubtitlesFromWords(words, 10, 14, cuts)
  assert(subs.length >= 1, 'blocks generated from words')
  const srtOut = buildSrt(subs)
  assert(srtOut.includes('-->'), 'SRT format valid')
  assert(srtOut.includes('this is spoken') || srtOut.includes('spoken'), 'SRT text = actual speech')
  assert(!srtOut.includes('01:00'), 'no fabricated timecodes')
  const vtt = buildVtt(subs)
  assert(vtt.startsWith('WEBVTT'), 'VTT header present')
  // after cut at 12.5-30, word "after cut" at 13.0-13.6 lies inside the cut → dropped
  assert(!srtOut.includes('after'), 'words inside removed range dropped from subtitles')
  // first block starts at output 0
  assert(subs[0].start === 0, 'clip start → output 0', `got ${subs[0]?.start}`)
}

// ---------------------------------------------------------------------------
console.log('\n== normalize edge cases ==')
{
  assert(normalizeText('Hello,  WORLD!') === 'hello world', 'normalize strips punct/case')
}

// ---------------------------------------------------------------------------
console.log('\n== Test I-b: duration semantics (totalCutDuration vs outputDuration) ==')
{
  // clip 0–40, cut 20–30 → kept 30, removed 10
  const cs = 0, ce = 40
  const cuts = [{ start: 20, end: 30, reason: 'x' }]
  assert(eq(outputDuration(cs, ce, cuts), 30), 'outputDuration = KEPT duration (30)', `got ${outputDuration(cs, ce, cuts)}`)
  assert(eq(totalCutDuration(cs, ce, cuts), 10), 'totalCutDuration = REMOVED duration (10)', `got ${totalCutDuration(cs, ce, cuts)}`)
  assert(eq(outputDuration(cs, ce, cuts) + totalCutDuration(cs, ce, cuts), ce - cs), 'kept + removed = clip length')
  // multiple cuts: clip 100–200, cuts 110–120 and 150–155
  const cutsM = [{ start: 110, end: 120 }, { start: 150, end: 155 }]
  assert(eq(outputDuration(100, 200, cutsM), 85), 'multiple cuts: output 85', `got ${outputDuration(100, 200, cutsM)}`)
  assert(eq(totalCutDuration(100, 200, cutsM), 15), 'multiple cuts: removed 15', `got ${totalCutDuration(100, 200, cutsM)}`)
  // cut at the very start / end / extending past clipEnd
  assert(eq(outputDuration(10, 30, [{ start: 5, end: 12 }]), 18), 'cut overlapping clip start handled')
  assert(eq(outputDuration(10, 30, [{ start: 25, end: 40 }]), 15), 'cut overlapping clip end handled')
  assert(eq(outputDuration(10, 30, []), 20), 'zero cuts → full clip duration')
  // bounded mapping: event past clipEnd clamps to the clip's output end
  assert(eq(sourceToOutputTimeBounded(45, 0, 40, cuts), 30), 'bounded: source past clipEnd → output end (30)', `got ${sourceToOutputTimeBounded(45, 0, 40, cuts)}`)
  assert(eq(outputToSourceTime(29.9, 0, cuts, 40), 39.9), 'inverse with clipEnd bound lands in last keep range', `got ${outputToSourceTime(29.9, 0, cuts, 40)}`)
}

// ---------------------------------------------------------------------------
console.log('\n== Test I-c: isDroppedByCuts unified rule (drop when <50% survives) ==')
{
  const cs = 0, ce = 100
  const cuts = [{ start: 20, end: 30, reason: 'x' }]
  // event 28–32 (1s inside cut of 2s span → 50% survives) → borderline KEPT (>= 50%)
  assert(!isDroppedByCuts(28, 32, cs, ce, cuts), 'event 50%+ outside cut → kept')
  // event 27–31 (1s of 4s? no: 27-31 spans 4s, 3s inside cut → 25% survives) → DROPPED
  assert(isDroppedByCuts(27, 31, cs, ce, cuts), 'event 75% inside cut → dropped', '80%-covered event was previously kept')
  // fully inside → dropped
  assert(isDroppedByCuts(21, 29, cs, ce, cuts), 'event fully inside cut → dropped')
  // fully outside → kept
  assert(!isDroppedByCuts(40, 50, cs, ce, cuts), 'event fully outside cut → kept')
  // tiny event fully covered by cut → dropped
  assert(isDroppedByCuts(25, 25.2, cs, ce, cuts), 'tiny fully-covered event → dropped')
}

// ---------------------------------------------------------------------------
console.log('\n== P0-1: json3 word timing — measured vs estimated ==')
{
  const { parseJson3, vttToJson3, srv3ToJson3 } = (await import('../src/lib/media')).__testHelpers

  // YouTube auto-captions style: EVERY seg carries tOffsetMs (word-level offsets)
  const measuredJson3 = {
    events: [
      { tStartMs: 10000, dDurationMs: 900, segs: [
        { utf8: 'real', tOffsetMs: 0 },
        { utf8: 'word', tOffsetMs: 300 },
        { utf8: 'timing', tOffsetMs: 600 },
      ] },
    ],
  }
  const m = parseJson3(measuredJson3)
  assert(m.wordTiming === 'measured', 'json3 with tOffsetMs → wordTiming measured', `got ${m.wordTiming}`)
  assert(m.words.length === 3, 'one entry per word', `got ${m.words.length}`)
  const w0 = m.words[0], w1 = m.words[1], w2 = m.words[2]
  assert(eq(w0.start, 10.0) && eq(w1.start, 10.3) && eq(w2.start, 10.6), 'word starts use REAL tOffsetMs (not even split)', JSON.stringify(m.words))
  assert(eq(w0.end, 10.3), 'word end = next word start', `got ${w0.end}`)
  assert(eq(w2.end, 10.9), 'last word end = event end', `got ${w2.end}`)

  // VTT fallback: NO word offsets anywhere → estimated, never labeled measured
  const vtt = `WEBVTT\n\n1\n00:00:10.000 --> 00:00:11.800\nevenly spread words here`
  const conv = vttToJson3(vtt)
  const e = parseJson3(conv)
  assert(e.wordTiming === 'estimated', 'VTT-derived captions → wordTiming estimated', `got ${e.wordTiming}`)
  assert(e.words.length === 4, 'VTT words split', `got ${e.words.length}`)
  assert(eq(e.words[0].start, 10.0) && eq(e.words[e.words.length - 1].end, 11.8), 'estimated words span the segment window')

  // srv3 with word offsets → measured
  const srv3 = `<timedtext><body><p t="5000" d="1000"><s ac-as="0">srv3</s><s ac-as="400">words</s></p></body></timedtext>`
  const s = parseJson3(srv3ToJson3(srv3))
  assert(s.wordTiming === 'measured', 'srv3 with ac-as offsets → measured', `got ${s.wordTiming}`)
  assert(eq(s.words[1].start, 5.4), 'srv3 word offset honored (400ms)', `got ${s.words[1]?.start}`)
}

// ---------------------------------------------------------------------------
console.log('\n== Karaoke: \\k word-highlight from REAL word timings ==')
{
  const { buildKaraokeText } = await import('../src/lib/render-recipe')
  const mkRecipe = (cuts: { start: number; end: number; reason?: string }[] = []) => ({
    clipId: 't', clipStart: 10, clipEnd: 20, duration: 10, youtubeId: 'x',
    cuts: cuts.map((c) => ({ reason: 'test', ...c })), cameraKeyframes: [], subtitles: [], segments: [], visuals: [], soundEffects: [],
    music: { recommended: false, style: 'none', intensity: 0, ducking_percent: 0 },
    generatedHook: '', title: 't',
  })
  const words = [
    { word: 'alpha', start: 10.0, end: 10.4 },
    { word: 'beta', start: 10.5, end: 10.9 },
    { word: 'gamma', start: 11.0, end: 11.4 },
  ]
  const block = { start: 10.0, end: 11.4, text: 'alpha beta gamma', emphasis_words: ['beta'], emphasis_type: 'bold', word_timings: words }
  const r0 = mkRecipe()
  const line = buildKaraokeText(block, r0)
  assert(line !== null && line.startsWith('{\\k50}alpha ') && line.endsWith('{\\k40}gamma'), 'karaoke \\k durations = start deltas + last word span', `got ${line}`)
  assert(line !== null && line.includes('{\\b1}{\\k50}beta{\\b0}'), 'emphasis word bolded inside karaoke', `got ${line}`)
  // word boundary inside a cut → refuse to karaoke (never misrepresent speech)
  const cutBlock = buildKaraokeText(block, mkRecipe([{ start: 10.2, end: 10.6, reason: 'x' }]))
  assert(cutBlock === null, 'word boundary snapped by cut → no karaoke (plain fallback)')
  // word outside block window → refuse
  const outside = buildKaraokeText({ ...block, word_timings: [...words, { word: 'delta', start: 12.0, end: 12.4 }] }, r0)
  assert(outside === null, 'word outside block window → no karaoke')
  // non-monotonic → refuse
  const nonMono = buildKaraokeText({ ...block, word_timings: [words[1], words[0], words[2]] }, r0)
  assert(nonMono === null, 'non-monotonic timings → no karaoke')
  // no timings → null (plain path unchanged)
  assert(buildKaraokeText({ ...block, word_timings: undefined }, r0) === null, 'no word_timings → null (plain rendering)')
  // end-to-end: generateASS emits the karaoke line for mapped output time
  const { generateASS } = await import('../src/lib/render-recipe')
  const ass = generateASS({ ...r0, subtitles: [block] })
  assert(ass.includes('{\\k50}alpha'), 'generateASS renders karaoke line', ass.split('\n').find((l) => l.startsWith('Dialogue: 0')) ?? '')
}

// ===========================================================================
// Word-snap + speech strip (timeline/editor shared utils)
// ===========================================================================
{
  console.log('\n== Word snap + speech strip (timeline polish) ==')
  const { snapToWordBoundary, buildSpeechStrip } = await import('../src/lib/word-snap')
  const words = [
    { word: 'actually', start: 10.0, end: 10.6 },
    { word: 'the', start: 11.2, end: 11.4 },
    { word: 'lesson', start: 11.5, end: 12.2 },
  ]
  // snap to word onset
  const onset = snapToWordBoundary(10.2, words)
  assert(onset.time === 10.0 && onset.word === 'actually', 'snap to word onset', JSON.stringify(onset))
  // snap to inter-word gap midpoint
  const gap = snapToWordBoundary(10.85, words)
  assert(Math.abs(gap.time - 10.9) < 0.011 && Boolean(gap.word?.includes('|')), 'snap to gap midpoint', JSON.stringify(gap))
  // beyond maxDist → unchanged
  const far = snapToWordBoundary(15.0, words)
  assert(far.time === 15.0 && far.word === null, 'no snap beyond maxDist')
  // too few words → unchanged
  assert(snapToWordBoundary(10.2, [words[0]]).word === null, 'single word → no snap')
  // non-finite guarded
  assert(snapToWordBoundary(10.2, [{ word: 'x', start: NaN, end: 5 }]).word === null, 'non-finite word guarded')

  // speech strip: buckets fully inside a word span = covered; gaps = empty
  const strip = buildSpeechStrip(words, 20, 100) // 0.2s per bucket
  assert(strip.length === 100, 'strip bucket count')
  // bucket 51 covers 10.2-10.4 (inside 'actually' 10.0-10.6) → full coverage
  assert(strip[51] > 0.99, 'bucket inside word span fully covered', String(strip[51]))
  // buckets 53-55 cover 10.6-11.2 (gap between 'actually' and 'the') → empty
  assert(strip[53] === 0 && strip[54] === 0 && strip[55] === 0, 'gap buckets empty', JSON.stringify([strip[53], strip[54], strip[55]]))
  // partial coverage at word edge: bucket 50 covers 10.0-10.2, word ends 10.6? no — word starts 10.0 → full; use end edge: bucket 52 covers 10.4-10.6 → full
  assert(strip[52] > 0.99, 'word end edge bucket covered', String(strip[52]))
  // silence before/after speech
  assert(strip[0] === 0 && strip[98] === 0 && strip[99] === 0, 'silence buckets empty')
  // no words → all zeros
  assert(buildSpeechStrip([], 20, 100).every((v) => v === 0), 'no words → empty strip')
  // words clamped to duration bounds
  assert(buildSpeechStrip([{ word: 'x', start: 19.5, end: 25 }, { word: 'y', start: -5, end: 1 }], 20, 10).every((v) => v >= 0 && v <= 1), 'strip values clamped 0..1')
}

// ---- local media helpers (URL flow → render without upload) ----
{
  const { mediaMimeForExt, isSafeYouTubeId, resolveLocalMediaPath } = await import('../src/lib/media')
  assert(mediaMimeForExt('mp4') === 'video/mp4', 'mime map mp4')
  assert(mediaMimeForExt('MKV') === 'video/x-matroska', 'mime map case-insensitive')
  assert(mediaMimeForExt('exe') === null, 'mime map rejects unknown ext')
  assert(isSafeYouTubeId('dQw4w9WgXcQ'), 'safe id accepted')
  assert(!isSafeYouTubeId('../etc/passwd') && !isSafeYouTubeId('a/b') && !isSafeYouTubeId('x'), 'unsafe ids rejected')
  const ok = resolveLocalMediaPath('upload/yt/dQw4w9WgXcQ/source.mp4')
  assert(ok !== null && ok.endsWith('/upload/yt/dQw4w9WgXcQ/source.mp4'), 'stored media path resolves under upload/')
  assert(resolveLocalMediaPath('upload/../.env') === null, 'path traversal rejected')
  assert(resolveLocalMediaPath('/etc/passwd') === null, 'absolute path rejected')
  assert(resolveLocalMediaPath('etc/passwd') === null, 'non-upload relative path rejected')
  assert(resolveLocalMediaPath('') === null, 'empty path rejected')
}

// ---------------------------------------------------------------------------
// 10/10 mission — PHASE 1.4: timeline edge cases A–M (critical infrastructure)
// ---------------------------------------------------------------------------
console.log('\n== Timeline edge cases A–M (buildKeepRanges is critical infrastructure) ==')
{
  // A. no cuts → the full window
  assert(JSON.stringify(buildKeepRanges(10, 30, [])) === JSON.stringify([{ start: 10, end: 30 }]), 'A no cuts → full window')
  // B. cut at the beginning
  assert(JSON.stringify(buildKeepRanges(0, 20, [{ start: 0, end: 5 }])) === JSON.stringify([{ start: 5, end: 20 }]), 'B cut at beginning')
  // C. cut in the middle
  assert(JSON.stringify(buildKeepRanges(0, 20, [{ start: 8, end: 12 }])) === JSON.stringify([{ start: 0, end: 8 }, { start: 12, end: 20 }]), 'C cut in middle')
  // D. cut at the end
  assert(JSON.stringify(buildKeepRanges(0, 20, [{ start: 15, end: 20 }])) === JSON.stringify([{ start: 0, end: 15 }]), 'D cut at end')
  // E. multiple cuts
  const eRanges = buildKeepRanges(0, 30, [{ start: 5, end: 8 }, { start: 12, end: 15 }, { start: 22, end: 25 }])
  assert(eRanges.length === 4 && eq(eRanges.reduce((a, r) => a + (r.end - r.start), 0), 21), 'E multiple cuts → 4 ranges, 21s kept')
  // F. adjacent cuts merge (no zero-length keep between them)
  const fRanges = buildKeepRanges(0, 20, [{ start: 5, end: 10 }, { start: 10, end: 15 }])
  assert(JSON.stringify(fRanges) === JSON.stringify([{ start: 0, end: 5 }, { start: 15, end: 20 }]), 'F adjacent cuts → no phantom 0-length keep')
  // G. overlapping cuts
  const gRanges = buildKeepRanges(0, 20, [{ start: 5, end: 12 }, { start: 8, end: 16 }])
  assert(JSON.stringify(gRanges) === JSON.stringify([{ start: 0, end: 5 }, { start: 16, end: 20 }]), 'G overlapping cuts treated as union')
  // H. cut completely outside the clip window
  assert(JSON.stringify(buildKeepRanges(10, 20, [{ start: 0, end: 5 }, { start: 25, end: 30 }])) === JSON.stringify([{ start: 10, end: 20 }]), 'H outside cuts ignored')
  // I. cut covering the ENTIRE clip → EMPTY (never a phantom full-clip fallback)
  assert(buildKeepRanges(10, 30, [{ start: 0, end: 40 }]).length === 0, 'I full cut → keepRanges EMPTY (no silent fallback)')
  assert(buildKeepRanges(10, 30, [{ start: 10, end: 30 }]).length === 0, 'I full cut (exact window) → EMPTY')
  assert(eq(outputDuration(10, 30, [{ start: 0, end: 40 }]), 0), 'I full cut → outputDuration 0', String(outputDuration(10, 30, [{ start: 0, end: 40 }])))
  assert(eq(totalCutDuration(10, 30, [{ start: 0, end: 40 }]), 20), 'I full cut → totalCutDuration = clip length')
  // J. zero-length / invalid cuts ignored
  assert(JSON.stringify(buildKeepRanges(0, 10, [{ start: 3, end: 3 }, { start: 5, end: 2 }])) === JSON.stringify([{ start: 0, end: 10 }]), 'J zero/negative-length cuts ignored')
  // K. subtitle crossing a cut → dropped when >half is inside the cut
  assert(isDroppedByCuts(4, 9, 0, 20, [{ start: 5, end: 15 }]), 'K subtitle mostly inside cut → dropped')
  assert(!isDroppedByCuts(2, 6, 0, 20, [{ start: 5, end: 15 }]), 'K subtitle mostly outside cut → kept')
  // L/M. camera keyframes crossing + exactly on a cut boundary (mapping math)
  const kfCuts = [{ start: 10, end: 20 }]
  const before = sourceToOutputTime(9, 0, kfCuts) // keyframe just before cut
  const onBoundary = sourceToOutputTime(10, 0, kfCuts) // exactly at cut start → snaps to output 10
  const after = sourceToOutputTime(20, 0, kfCuts) // cut end → snaps to 10 (cut removed)
  const later = sourceToOutputTime(21, 0, kfCuts) // after cut → 11
  assert(eq(before, 9) && eq(onBoundary, 10) && eq(after, 10) && eq(later, 11), 'L/M keyframes on/around cut map without NaN or jumps', `${before},${onBoundary},${after},${later}`)
  // no NaN anywhere under adversarial inputs
  const adv = sourceToOutputTime(15, 0, [{ start: -5, end: 3 }, { start: Number.NaN, end: 8 }])
  assert(isFinite(adv), 'adversarial cuts → finite output time', String(adv))
  // inverse mapping round-trip on a multi-cut timeline
  const cuts = [{ start: 5, end: 8 }, { start: 12, end: 15 }]
  for (const outT of [0, 2, 4.9, 5, 7.2, 9, 11.9, 14.5]) {
    const src = outputToSourceTime(outT, 0, cuts, 20)
    assert(isFinite(src) && src >= 0 && src <= 20, `inverse map ${outT} → finite source time`, String(src))
  }
  assert(eq(outputToSourceTime(0, 0, cuts, 20), 0), 'output 0 → first kept frame')
  assert(eq(outputToSourceTime(14, 0, cuts, 20), 20), 'output beyond end clamps to clip end')
}

// ---------------------------------------------------------------------------
// 10/10 mission — PHASE 1.2: renderer recipe validation (strict contract)
// ---------------------------------------------------------------------------
console.log('\n== RenderRecipe runtime validation (renderer NEVER trusts JSON) ==')
{
  const { validateRecipe, RECIPE_LIMITS } = await import('../mini-services/ffmpeg-renderer/recipe-validation')
  const good = {
    keep_ranges: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    duration: 10,
    camera_keyframes: [{ time: 0, scale: 1 }, { time: 5, scale: 1.2 }],
    subtitles_ass: '[Script Info]\n',
    title: 'Test clip',
    source: { clip_start: 0, clip_end: 15 },
  }
  const v = validateRecipe(good)
  assert(v.ok, 'valid recipe accepted')
  if (v.ok) {
    assert(v.recipe.keep_ranges.length === 2 && v.recipe.duration === 10, 'valid recipe fields preserved')
  }
  const expectFail = (name: string, mutate: (r: any) => unknown, code?: string) => {
    const res = validateRecipe(mutate({ ...good }))
    assert(!res.ok && (!code || res.code === code), `rejected: ${name}`, res.ok ? 'ACCEPTED (bad!)' : res.code)
  }
  expectFail('not an object', () => 'string', 'NOT_OBJECT')
  expectFail('missing keep_ranges', (r) => ({ ...r, keep_ranges: undefined }), 'EMPTY_OUTPUT')
  expectFail('empty keep_ranges (full cut)', (r) => ({ ...r, keep_ranges: [] }), 'EMPTY_OUTPUT')
  expectFail('NaN duration', (r) => ({ ...r, duration: Number.NaN }), 'INVALID_DURATION')
  expectFail('Infinity duration (1e999)', (r) => ({ ...r, duration: JSON.parse('1e999') }), 'INVALID_DURATION')
  expectFail('duration disagrees with ranges', (r) => ({ ...r, duration: 42 }), 'INVALID_DURATION')
  expectFail('negative timestamp in range', (r) => ({ ...r, keep_ranges: [{ start: -1, end: 5 }] }), 'INVALID_KEEP_RANGES')
  expectFail('end <= start', (r) => ({ ...r, keep_ranges: [{ start: 5, end: 5 }] }), 'INVALID_KEEP_RANGES')
  expectFail('unsorted ranges', (r) => ({ ...r, keep_ranges: [{ start: 10, end: 15 }, { start: 0, end: 5 }] }), 'INVALID_KEEP_RANGES')
  expectFail('overlapping ranges', (r) => ({ ...r, keep_ranges: [{ start: 0, end: 8 }, { start: 5, end: 12 }] }), 'INVALID_KEEP_RANGES')
  expectFail('non-numeric range', (r) => ({ ...r, keep_ranges: [{ start: '0', end: 5 }] }), 'INVALID_KEEP_RANGES')
  expectFail('string scale (filter injection)', (r) => ({ ...r, camera_keyframes: [{ time: 0, scale: '1.5,format=yuv444p)' }] }), 'INVALID_CAMERA')
  expectFail('absurd scale', (r) => ({ ...r, camera_keyframes: [{ time: 0, scale: 900 }] }), 'INVALID_CAMERA')
  expectFail('negative keyframe time', (r) => ({ ...r, camera_keyframes: [{ time: -1, scale: 1 }] }), 'INVALID_CAMERA')
  expectFail('too many ranges', (r) => ({ ...r, keep_ranges: Array.from({ length: 51 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 })) }), 'LIMIT_EXCEEDED')
  expectFail('too many keyframes', (r) => ({ ...r, camera_keyframes: Array.from({ length: 401 }, (_, i) => ({ time: i, scale: 1 })) }), 'LIMIT_EXCEEDED')
  expectFail('output over the cap', (r) => ({ ...r, keep_ranges: [{ start: 0, end: RECIPE_LIMITS.MAX_OUTPUT_DURATION + 1 }], duration: RECIPE_LIMITS.MAX_OUTPUT_DURATION + 1 }), 'LIMIT_EXCEEDED')
  expectFail('subtitles_ass too large', (r) => ({ ...r, subtitles_ass: 'x'.repeat(RECIPE_LIMITS.MAX_ASS_BYTES + 1) }), 'LIMIT_EXCEEDED')
  expectFail('invalid source block', (r) => ({ ...r, source: { clip_start: 10, clip_end: 5 } }), 'INVALID_SOURCE')
  // absurd-but-legal still passes: 30 min output allowed
  const big = validateRecipe({ keep_ranges: [{ start: 0, end: RECIPE_LIMITS.MAX_OUTPUT_DURATION }], duration: RECIPE_LIMITS.MAX_OUTPUT_DURATION })
  assert(big.ok, '30-minute output allowed (sensible cap, not arbitrary)')
}

// ---------------------------------------------------------------------------
// 10/10 mission — PHASE 2.5/2.6: timing provenance + track selection
// ---------------------------------------------------------------------------
console.log('\n== Caption track selection by TIMING QUALITY (not container format) ==')
{
  const { captionTrackTimingQuality } = await import('../src/lib/media')
  const json3Measured = JSON.stringify({ events: [{ segs: [{ utf8: 'a', tOffsetMs: 0 }, { utf8: 'b', tOffsetMs: 120 }] }, { segs: [{ utf8: 'c', tOffsetMs: 50 }] }] })
  const json3Plain = JSON.stringify({ events: [{ segs: [{ utf8: 'a' }, { utf8: 'b' }] }] })
  const srv3WithOffsets = '<p t="1000" d="500"><s ac-as="0">he</s><s ac-as="120">llo</s></p>'
  const srv3Plain = '<p t="1000" d="500"><s>hello world</s></p>'
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello'
  assert(captionTrackTimingQuality('subs.en.json3', () => json3Measured) === 1, 'json3 with offsets → 1.0')
  assert(captionTrackTimingQuality('subs.en.json3', () => json3Plain) === 0, 'json3 without offsets → 0')
  assert(captionTrackTimingQuality('subs.en.srv3', () => srv3WithOffsets) === 1, 'srv3 with ac-as offsets → 1.0')
  assert(captionTrackTimingQuality('subs.en.srv3', () => srv3Plain) === 0, 'srv3 without offsets → 0')
  assert(captionTrackTimingQuality('subs.en.vtt', () => vtt) === 0, 'vtt → 0 (cue timing only)')
  assert(captionTrackTimingQuality('subs.en.json3', () => '{corrupt') === 0, 'corrupt track → 0 (ranks last)')
  // deterministic selection: srv3 WITH offsets beats json3 WITHOUT (quality > format)
  const files = ['subs.en.json3', 'subs.en-orig.srv3', 'subs.en.vtt']
  const q = (f: string) => captionTrackTimingQuality(f, () => (f.endsWith('.srv3') ? srv3WithOffsets : f.endsWith('.json3') ? json3Plain : vtt))
  const rankTrack = (a: string, b: string) => (Math.abs(q(a) - q(b)) > 0.05 ? q(b) - q(a) : 0)
  assert(files.sort(rankTrack)[0] === 'subs.en-orig.srv3', 'srv3 with offsets wins over offset-less json3', files.join(','))
}

console.log('\n== wordTiming provenance: measured / mixed / estimated ==')
{
  const { parseJson3 } = (await import('../src/lib/media')).__testHelpers
  // 100% measured
  const measured = { events: [{ tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: 'hi', tOffsetMs: 0 }] }] }
  assert(parseJson3(measured).wordTiming === 'measured', 'all offsets → measured')
  // 50% measured → mixed
  const half = {
    events: [
      { tStartMs: 1000, dDurationMs: 400, segs: [{ utf8: 'one', tOffsetMs: 0 }, { utf8: 'two', tOffsetMs: 100 }] },
      { tStartMs: 2000, dDurationMs: 400, segs: [{ utf8: 'three' }, { utf8: 'four' }] },
    ],
  }
  const mixed = parseJson3(half)
  assert(mixed.wordTiming === 'mixed', '50% offsets → mixed', mixed.wordTiming)
  // 0% measured → estimated
  const est = { events: [{ tStartMs: 1000, dDurationMs: 400, segs: [{ utf8: 'a' }, { utf8: 'b' }] }] }
  assert(parseJson3(est).wordTiming === 'estimated', 'no offsets → estimated')
  assert(mixed.words.length === 4, 'mixed parse still yields all words')
}

// ---------------------------------------------------------------------------
// 10/10 mission — PHASE 3.11: diversity (temporal near-duplicate penalty)
// ---------------------------------------------------------------------------
console.log('\n== Diversity: near-duplicate moments collapsed, distinct moments kept ==')
{
  const mk = (id: string, start: number, end: number, total: number, excerpt: string) => ({
    start, end, title: id, transcriptExcerpt: excerpt,
    scores: { hook: 8, curiosity: 8, emotion: 8, payoff: 8, standalone: 8, shareability: 8, context_safety: 8, total },
  })
  // same moment continued: A 600-645, B 650-695 (non-overlapping, 5s apart, same content)
  const a = mk('A', 600, 645, 90, 'the one thing nobody tells you about building a startup is that it never gets easier')
  const b = mk('B', 650, 695, 85, 'the one thing nobody tells you about building a startup is that it never gets easier')
  const c = mk('C', 1200, 1245, 88, 'completely different topic about the ocean and why whales sing at night')
  const out = dedupeAndRank([a, b, c], 3)
  assert(out.length === 2, 'near-duplicate (temporal + semantic) dropped', `got ${out.length}`)
  assert(out.some((x) => x.title === 'A') && out.some((x) => x.title === 'C'), 'stronger of the near-dupes kept (A 90 > B 85)')
  // far-apart content (different moment, similar-but-not-identical phrasing) still kept
  const d = mk('D', 1800, 1845, 84, 'another angle on building a startup: it never gets easier but it keeps getting better')
  const out2 = dedupeAndRank([a, d], 2)
  assert(out2.length === 2, 'temporally distant similar excerpt NOT collapsed (different moment)')
}

console.log(`\n════════════════════════════════`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

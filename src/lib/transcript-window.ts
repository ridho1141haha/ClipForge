/**
 * LONG-VIDEO TRANSCRIPT RETRIEVAL (analyze prompt construction)
 *
 * PROBLEM (fixed): the old prompt sent timestamps for only the FIRST 400
 * words and head-truncated the transcript text. For a 1-hour video the model
 * had temporal grounding for ~2 minutes of speech — candidate moments late in
 * the video could not be grounded, and discovery systematically favored the
 * opening minutes.
 *
 * ARCHITECTURE (retrieval, not brute force):
 *
 *   FULL TRANSCRIPT (+ word timings)
 *        ↓
 *   inline [mm:ss] markers every MARKER_EVERY_WORDS words  ← constant-cost
 *        ↓                                                 temporal spine
 *   length budget → deterministic BLOCK STRIDE when over   (whole timeline
 *        ↓                                                  stays represented)
 *   prompt section with honest elision markers
 *        ↓
 *   (server-side grounding is UNCHANGED: processCandidate validates/snaps
 *   candidate windows against the FULL word array — the prompt is discovery
 *   input only; the server remains the authority)
 *
 * Determinism: same transcript + words → byte-identical output. No LLM is
 * involved here; nothing is fabricated — elided regions are explicitly
 * marked so the model can never quote across a gap.
 */

export interface TranscriptWord { word: string; start: number; end: number }

export interface MarkedTranscript {
  /** prompt-ready transcript text (markers + optional elision markers) */
  text: string
  /** number of [mm:ss] markers inserted */
  markers: number
  /** true when content was deterministically elided to fit the budget */
  truncated: boolean
  /** 'full' = whole timeline represented verbatim; 'strided' = elided blocks */
  coverage: 'full' | 'strided'
}

const MARKER_EVERY_WORDS = 40
export const TRANSCRIPT_MARKER_EVERY_WORDS = MARKER_EVERY_WORDS
/** prompt text budget in characters (~20k tokens — safe for current models) */
export const TRANSCRIPT_PROMPT_BUDGET = 80_000
/** words per strided block (blocks are kept/dropped as units) */
const BLOCK_WORDS = 200
/** minimum blocks the stride ever keeps (block 0 + last → beginning & end survive) */
const MIN_KEEP_BLOCKS = 2
/** honest label appended when even the minimal stride cannot fit the budget */
const TAIL_MARKER = ' [… transcript truncated to fit the prompt budget — remainder elided …]'

function fmtMarker(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `[${m}:${String(r).padStart(2, '0')}]`
}

/**
 * Insert inline [mm:ss] timestamps across the WHOLE word stream (constant
 * token cost regardless of video length). Words are emitted verbatim —
 * markers never replace or reorder speech.
 */
export function markWords(words: TranscriptWord[]): { text: string; markers: number } {
  let markers = 0
  const out: string[] = []
  let sinceMarker = 0
  for (const w of words) {
    if (sinceMarker >= MARKER_EVERY_WORDS) {
      out.push(fmtMarker(w.start))
      markers++
      sinceMarker = 0
    }
    out.push(w.word)
    sinceMarker++
  }
  return { text: out.join(' '), markers }
}

/**
 * Deterministic stride that FITS the budget by construction: build a candidate,
 * MEASURE its final length (elision labels add characters the naive
 * maxChars/avgBlock estimate ignores), drop blocks until it fits, rebuild.
 * Each candidate is built by strideBlocks (deterministic), so the fixed point
 * is deterministic too. keepCount never goes below MIN_KEEP_BLOCKS — block 0
 * and the last block always survive (beginning & end coverage).
 */
function strideToFit(
  blocks: string[],
  totalChars: number,
  maxChars: number,
  elisionLabel: (from: number, to: number) => string,
): string {
  if (blocks.length === 0) return ''
  const avgBlock = Math.max(1, totalChars / blocks.length)
  const labelLen = elisionLabel(0, 1).length
  let keepCount = Math.max(
    Math.min(MIN_KEEP_BLOCKS, blocks.length),
    Math.min(blocks.length, Math.floor(maxChars / avgBlock)),
  )
  let out = strideBlocks(blocks, keepCount, elisionLabel)
  // measure-and-shrink loop (deterministic: fixed step from measured overshoot)
  while (out.length > maxChars && keepCount > Math.min(MIN_KEEP_BLOCKS, blocks.length)) {
    const overshoot = out.length - maxChars
    const savedPerBlock = avgBlock + labelLen
    keepCount = Math.max(
      Math.min(MIN_KEEP_BLOCKS, blocks.length),
      keepCount - Math.max(1, Math.ceil(overshoot / savedPerBlock)),
    )
    out = strideBlocks(blocks, keepCount, elisionLabel)
  }
  return out
}

/**
 * Last-resort guard for inputs the stride cannot compress (e.g. a transcript
 * with no whitespace — one giant block — or a budget smaller than a single
 * block): cut honestly to maxChars and label the cut. Content is REMOVED,
 * never fabricated; determinism preserved.
 */
function hardCutToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars > TAIL_MARKER.length) return text.slice(0, maxChars - TAIL_MARKER.length) + TAIL_MARKER
  return text.slice(0, Math.max(0, maxChars))
}
function strideBlocks(blocks: string[], keepCount: number, elisionLabel: (from: number, to: number) => string): string {
  const total = blocks.length
  if (keepCount >= total) return blocks.join(' ')
  const kept = new Set<number>()
  // evenly spaced sample including the FIRST and LAST block (no head bias)
  for (let i = 0; i < keepCount; i++) {
    const idx = Math.round((i * (total - 1)) / Math.max(1, keepCount - 1))
    kept.add(idx)
  }
  const parts: string[] = []
  let run: number[] = []
  const flushRun = () => {
    if (run.length === 0) return
    parts.push(run.map((i) => blocks[i]).join(' '))
    run = []
  }
  for (let i = 0; i < total; i++) {
    if (kept.has(i)) {
      run.push(i)
    } else {
      flushRun()
    }
  }
  flushRun()
  // count elided blocks between kept runs and label each gap honestly
  const out: string[] = []
  let blockIdx = 0
  let partIdx = 0
  while (blockIdx < total) {
    if (kept.has(blockIdx)) {
      out.push(parts[partIdx++])
      // advance past this contiguous run
      while (blockIdx < total && kept.has(blockIdx)) blockIdx++
    } else {
      let gapEnd = blockIdx
      while (gapEnd < total && !kept.has(gapEnd)) gapEnd++
      out.push(elisionLabel(blockIdx, gapEnd - 1))
      blockIdx = gapEnd
    }
  }
  return out.join(' ')
}

/**
 * Build the analyze prompt's transcript section body.
 *
 * With word timings: full-timeline [mm:ss] markers + (only when needed)
 * deterministic striding. Without word timings: the raw transcript, strided
 * the same way when over budget (temporal markers are impossible without
 * word data — honest absence, never fabricated timestamps).
 *
 * INVARIANT: the returned text is ALWAYS <= maxChars for every input — the
 * stride loop measures real output length (including elision labels) and a
 * final hard-cut guard covers inputs the stride cannot compress.
 */
export function buildTimestampedTranscript(
  transcript: string,
  words: TranscriptWord[],
  opts?: { maxChars?: number },
): MarkedTranscript {
  const maxChars = Math.max(0, opts?.maxChars ?? TRANSCRIPT_PROMPT_BUDGET)

  if (words.length > 0) {
    const marked = markWords(words)
    if (marked.text.length <= maxChars) {
      return { text: marked.text, markers: marked.markers, truncated: false, coverage: 'full' }
    }
    // over budget → deterministic block stride across the whole timeline
    // (split on the marked text's whitespace, BLOCK_WORDS-word blocks), then
    // measured to fit: elision labels count against the budget.
    const tokens = marked.text.split(' ')
    const blocks: string[] = []
    for (let i = 0; i < tokens.length; i += BLOCK_WORDS) {
      blocks.push(tokens.slice(i, i + BLOCK_WORDS).join(' '))
    }
    const label = (from: number, to: number) => ` [… transcript ${from * BLOCK_WORDS}–${(to + 1) * BLOCK_WORDS} words elided for length — never quote across this gap …] `
    const strided = hardCutToBudget(strideToFit(blocks, marked.text.length, maxChars, label), maxChars)
    return { text: strided, markers: marked.markers, truncated: true, coverage: 'strided' }
  }

  // no word timing: raw text only (no fabricated timestamps)
  if (transcript.length <= maxChars) {
    return { text: transcript, markers: 0, truncated: false, coverage: 'full' }
  }
  const tokens = transcript.split(/\s+/)
  const blocks: string[] = []
  for (let i = 0; i < tokens.length; i += BLOCK_WORDS) {
    blocks.push(tokens.slice(i, i + BLOCK_WORDS).join(' '))
  }
  const label = (from: number, to: number) => ` [… transcript blocks ${from + 1}–${to + 1} elided for length — never quote across this gap …] `
  const strided = hardCutToBudget(strideToFit(blocks, transcript.length, maxChars, label), maxChars)
  return { text: strided, markers: 0, truncated: true, coverage: 'strided' }
}

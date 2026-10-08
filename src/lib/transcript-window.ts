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
 * Deterministic block stride: keep whole blocks so the kept content spans the
 * full timeline. Returns the kept text with explicit elision markers between
 * non-contiguous blocks (the model is told these are gaps, never to quote
 * across them).
 */
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
 */
export function buildTimestampedTranscript(
  transcript: string,
  words: TranscriptWord[],
  opts?: { maxChars?: number },
): MarkedTranscript {
  const maxChars = Math.max(4000, opts?.maxChars ?? TRANSCRIPT_PROMPT_BUDGET)

  if (words.length > 0) {
    const marked = markWords(words)
    if (marked.text.length <= maxChars) {
      return { text: marked.text, markers: marked.markers, truncated: false, coverage: 'full' }
    }
    // over budget → deterministic block stride across the whole timeline
    // (split on the marked text's whitespace, BLOCK_WORDS-word blocks)
    const tokens = marked.text.split(' ')
    const blocks: string[] = []
    for (let i = 0; i < tokens.length; i += BLOCK_WORDS) {
      blocks.push(tokens.slice(i, i + BLOCK_WORDS).join(' '))
    }
    const avgBlock = marked.text.length / blocks.length
    const keepCount = Math.max(2, Math.min(blocks.length, Math.floor(maxChars / avgBlock)))
    const strided = strideBlocks(blocks, keepCount, (from, to) => ` [… transcript ${from * BLOCK_WORDS}–${(to + 1) * BLOCK_WORDS} words elided for length — never quote across this gap …] `)
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
  const avgBlock = transcript.length / blocks.length
  const keepCount = Math.max(2, Math.min(blocks.length, Math.floor(maxChars / avgBlock)))
  const strided = strideBlocks(blocks, keepCount, (from, to) => ` [… transcript blocks ${from + 1}–${to + 1} elided for length — never quote across this gap …] `)
  return { text: strided, markers: 0, truncated: true, coverage: 'strided' }
}

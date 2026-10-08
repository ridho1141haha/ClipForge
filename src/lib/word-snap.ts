/**
 * Word-boundary snapping — shared by the clip editor sliders and the
 * timeline trim handles. Snaps a boundary time to the nearest speech
 * boundary derived from REAL word timestamps: word onsets, word endings,
 * and midpoints of inter-word gaps. Snapping never moves a boundary
 * somewhere speech does not support (and never beyond maxDist).
 */
export interface WordT {
  word: string
  start: number
  end: number
}

export function snapToWordBoundary(
  t: number,
  words: WordT[],
  maxDist = 1.5,
): { time: number; word: string | null } {
  if (!words || words.length < 2) return { time: t, word: null }
  const cands: { time: number; word: string }[] = []
  words.forEach((w, i) => {
    if (!isFinite(w.start) || !isFinite(w.end)) return
    cands.push({ time: w.start, word: w.word })
    cands.push({ time: w.end, word: w.word })
    const next = words[i + 1]
    if (next && isFinite(next.start)) {
      cands.push({ time: (w.end + next.start) / 2, word: `…${w.word} | ${next.word}…` })
    }
  })
  let best: { time: number; word: string | null } = { time: t, word: null }
  let bestD = Infinity
  for (const c of cands) {
    const d = Math.abs(c.time - t)
    if (d < bestD) {
      bestD = d
      best = { time: c.time, word: c.word }
    }
  }
  if (bestD > maxDist || best.word === null) return { time: t, word: null }
  return { time: Math.round(best.time * 10) / 10, word: best.word }
}

/**
 * Build a compact speech-density strip for timeline visualization:
 * N buckets over [0, duration]; each bucket = fraction (0..1) of time covered
 * by word spans (from REAL word timestamps; empty when no words available).
 */
export function buildSpeechStrip(
  words: WordT[],
  duration: number,
  buckets = 120,
): number[] {
  const out = new Array(Math.max(1, buckets)).fill(0)
  if (!words || words.length === 0 || !(duration > 0)) return out
  const bw = duration / buckets
  for (const w of words) {
    if (!isFinite(w.start) || !isFinite(w.end) || w.end <= w.start) continue
    const s = Math.max(0, w.start)
    const e = Math.min(duration, w.end)
    if (e <= s) continue
    let b0 = Math.floor(s / bw)
    const b1 = Math.min(buckets - 1, Math.ceil(e / bw) - 1)
    for (; b0 <= b1; b0++) {
      if (b0 < 0 || b0 >= buckets) continue
      // epsilon guard: bucket-edge float error (e.g. 11.2/0.2 = 55.999…)
      // must not register as micro-coverage in an adjacent silence bucket
      const overlap = Math.min(e, (b0 + 1) * bw) - Math.max(s, b0 * bw)
      if (overlap > 1e-9) out[b0] = Math.min(1, out[b0] + overlap / bw)
    }
  }
  return out
}

/**
 * Keep-range mapping for the real-source preview players.
 *
 * The FFmpeg renderer consumes `keep_ranges` produced by buildKeepRanges()
 * (src/lib/subtitles.ts). The in-browser preview (Remotion composition) must
 * match that contract EXACTLY so what you preview is what renders. This module
 * maps the renderer-grade keep ranges onto the OUTPUT timeline and back.
 */
import { buildKeepRanges } from '@/lib/subtitles'

export interface KeepRange {
  srcStart: number
  srcEnd: number
  /** where this range lands on the OUTPUT timeline (seconds) */
  outStart: number
}

/**
 * clip window minus cuts → keep ranges annotated with output offsets.
 * Delegates the range computation to buildKeepRanges so preview and renderer
 * can never diverge.
 */
export function mapKeepRanges(
  clipStart: number,
  clipEnd: number,
  cuts: { start: number; end: number }[],
): KeepRange[] {
  const base = buildKeepRanges(clipStart, clipEnd, cuts)
  const out: KeepRange[] = []
  let acc = 0
  for (const r of base) {
    out.push({ srcStart: r.start, srcEnd: r.end, outStart: acc })
    acc += r.end - r.start
  }
  return out
}

/**
 * Output-timeline time → source-timeline time.
 * Maps t (seconds on the edited/kept timeline) into the corresponding absolute
 * source time. t beyond the last range clamps to the end of that range.
 */
export function sourceTimeAtOutput(keepRanges: KeepRange[], t: number): number {
  if (keepRanges.length === 0) return 0
  const r =
    keepRanges.find((k) => t >= k.outStart && t < k.outStart + (k.srcEnd - k.srcStart)) ??
    keepRanges[keepRanges.length - 1]
  const offset = Math.min(Math.max(0, t - r.outStart), r.srcEnd - r.srcStart)
  return r.srcStart + offset
}

/** Total output duration of the kept material (seconds). */
export function keepRangesOutputDuration(keepRanges: KeepRange[]): number {
  if (keepRanges.length === 0) return 0
  const last = keepRanges[keepRanges.length - 1]
  return last.outStart + (last.srcEnd - last.srcStart)
}

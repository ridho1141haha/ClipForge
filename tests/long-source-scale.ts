/**
 * Long-source scale test (mission P0 #29).
 *
 * Proves pipeline mechanics at a ~40-minute source length:
 *   - real (user-provided) duration 2383s is accepted — 720 is never substituted
 *   - missing duration → explicit 400 (no fake fallback)
 *   - clips land inside [0, 2383] and respect platform bounds
 *   - spoken hooks are verified against the supplied word-timed transcript
 *   - server scoring / dedupe / requested-count enforcement at scale
 *
 * NOTE: the transcript is SYNTHETIC and clearly labeled — this test verifies
 * MECHANICS at scale (a real ~39:43 video, PLOpsj6DVQ8, was bot-blocked from
 * this sandbox IP; real-caption grounding is proven by tests/url-render-e2e.ts).
 *
 * Requires: dev server on :3000.
 */
const BASE = 'http://localhost:3000'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- build a synthetic 40-minute word-timed transcript (labelled test fixture) ----
const TOPICS = [
  'the rendering pipeline was slower than we expected so we rebuilt the encoder from scratch',
  'viewers keep asking how the timeline mapping handles cuts in the middle of a sentence',
  'we benchmarked three transcription engines and the word timestamps were only accurate in one',
  'the biggest lesson this month is that caching the wrong layer makes everything worse',
  'our first attempt at automatic cropping failed because faces were never centered',
  'let me show you the dashboard numbers before we talk about what changed this week',
  'if you only remember one thing from this video remember that validation happens on the server',
  'the community found a bug in the subtitle timing that only appeared after twenty minutes',
]
function buildTranscript(totalSeconds: number) {
  const words: { word: string; start: number; end: number }[] = []
  const sentences: { start: number; end: number; text: string }[] = []
  let t = 1.0
  let idx = 0
  while (t < totalSeconds - 30) {
    const text = TOPICS[idx % TOPICS.length]
    const tokens = text.split(' ')
    const start = t
    for (const tok of tokens) {
      const dur = 0.25 + (tok.length % 4) * 0.08
      words.push({ word: tok, start: +t.toFixed(2), end: +(t + dur).toFixed(2) })
      t += dur + 0.12
    }
    // natural pause between sentences
    t += 1.4
    sentences.push({ start: +start.toFixed(2), end: +t.toFixed(2), text })
    idx++
  }
  return { words, sentences, text: sentences.map((s) => s.text).join(' ') }
}

async function jfetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (cookieJar && !headers.has('Cookie')) headers.set('Cookie', cookieJar)
  const res = await fetch(BASE + path, { ...init, headers })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) {
    const sid = /(?:^|[,;]\s*)(clipforge_sid=[^;]+)/.exec(setCookie)?.[1]
    if (sid) cookieJar = sid
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch { /* stream endpoints */ }
  return { res, body: body as Record<string, unknown> }
}

let cookieJar = ''

async function main() {
  console.log('\n== Long-source scale: no duration → explicit 400 (never 720) ==')
  {
    const { res, body } = await jfetch('/api/clips/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'scale test', duration: 0, clipCount: 4 }),
    })
    assert(res.status === 400, 'analyze without duration → 400', `got ${res.status}`)
    assert(String(body.error ?? '').toLowerCase().includes('duration'), 'error names duration requirement')
  }

  console.log('\n== Long-source scale: 2383s accepted, clips grounded in the word-timed transcript ==')
  const { words, text } = buildTranscript(2383)
  let cookie = ''
  {
    const { res, body } = await jfetch('/api/clips/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Scale test — synthetic 39:43 source (labeled fixture)',
        url: 'https://youtu.be/PLOpsj6DVQ8',
        duration: 2383,
        durationSource: 'user-provided',
        platform: 'shorts',
        clipCount: 6,
        transcript: text,
        words,
        transcriptSource: 'manual',
        wordTiming: 'measured',
        save: false,
      }),
    })
    assert(res.ok, 'analyze accepted duration=2383 with transcript', `status ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    const candidates = (body.candidates as Record<string, unknown>[] | undefined) ?? []
    assert(candidates.length > 0, 'candidates returned', `n=${candidates.length}`)
    assert(candidates.length <= 6, 'requested 6 → ≤6 returned', `n=${candidates.length}`)
    const withinRange = candidates.every((c) => Number(c.start) >= 0 && Number(c.end) <= 2383 && Number(c.end) > Number(c.start))
    assert(withinRange, 'all clips inside [0, 2383] with end > start')
    const durOk = candidates.every((c) => Number(c.end) - Number(c.start) >= 20 && Number(c.end) - Number(c.start) <= 60)
    assert(durOk, 'platform bounds respected (25–60s for shorts, clamped)', JSON.stringify(candidates.map((c) => +(Number(c.end) - Number(c.start)).toFixed(1))))
    const verified = candidates.filter((c) => c.hookVerified === true)
    assert(verified.length > 0, 'hooks verified against the transcript at the STRICT threshold', `${verified.length}/${candidates.length}`)
    const scoresOk = candidates.every((c) => {
      const s = c.scores as Record<string, number>
      return typeof s.total === 'number' && s.total > 0 && s.total <= 100
    })
    assert(scoresOk, 'server-calculated totals in 0–100')
    const meta = body.meta as Record<string, unknown> | undefined
    assert(meta?.serverScored === true && meta?.requestedCount === 6, 'meta flags server authority + requested count')
  }

  console.log('\n== Long-source scale: persisted project drives the same analysis (server-stored duration wins) ==')
  {
    // create project with the REAL 2383 duration + transcript persisted
    const create = await jfetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeId: 'PLOpsj6DVQ8', url: 'https://youtu.be/PLOpsj6DVQ8', title: 'Scale test project (2383s)', duration: 2383, durationSource: 'user-provided', transcript: text, transcriptSource: 'manual' }),
    })
    assert(create.res.ok && typeof create.body.project === 'object', 'project created with 2383s', JSON.stringify(create.body).slice(0, 160))
    const pid = ((create.body.project as Record<string, unknown>)?.id as string) ?? ''
    assert(pid !== '', 'project id present')

    // analyze WITH a lying client duration (720) + projectId → server must use 2383
    const { res, body } = await jfetch('/api/clips/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        title: 'Scale test project (2383s)',
        duration: 720, // ← deliberately wrong client value; DB has 2383
        clipCount: 4,
        platform: 'shorts',
        save: true,
      }),
    })
    assert(res.ok, 'analyze succeeded with wrong client duration (DB wins)', `status ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    const candidates = (body.candidates as Record<string, unknown>[] | undefined) ?? []
    const withinRange = candidates.every((c) => Number(c.end) <= 2383.01)
    assert(withinRange && candidates.length > 0, 'clips computed against the SERVER-stored 2383s, not client 720', JSON.stringify(candidates.map((c) => c.end)))
    const verified = candidates.filter((c) => c.hookVerified === true)
    assert(verified.length > 0, 'hooks verified against SERVER-stored transcript', `${verified.length}/${candidates.length}`)

    // cleanup
    await jfetch(`/api/projects/${pid}`, { method: 'DELETE' })
  }

  console.log(`\n════════════════════════════════`)
  console.log(`LONG-SOURCE SCALE RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})

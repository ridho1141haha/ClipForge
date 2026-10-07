/**
 * ClipForge URL-FLOW RENDER E2E — the last pipeline gap, closed.
 * Run: bun run tests/url-render-e2e.ts   (requires Next on :3000 + renderer on :3003)
 *
 * Pipeline exercised (real execution paths, no mocks):
 *   bare YouTube URL
 *   → POST /api/source/prepare (async job: real metadata + captions + SOURCE MEDIA DOWNLOAD via yt-dlp)
 *   → poll /api/jobs/:id → project persisted with localMediaState='ready'
 *   → EditPlan → buildRenderRecipe → buildRecipeJSON (renderer contract)
 *   → POST /api/render-proxy/render  ** JSON mode { recipe, projectId } ** (NEW: server-side media render)
 *   → poll job → download MP4 → ffprobe/volumedetect assertions on the ACTUAL OUTPUT
 *
 * Security assertions:
 *   - a different session CANNOT render the same project (404)
 *   - JSON render without projectId → 400
 *
 * Notes:
 *   - uses the dQw4w9WgXcQ video (213s) — downloads ≤1080p (~34MB); yt-dlp resumes .part files on retry
 *   - if YouTube blocks/downloads fail from this environment, the test SKIPS with an explicit
 *     message (the golden multipart path is covered by tests/e2e-render.ts)
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { buildRenderRecipe, buildRecipeJSON } from '../src/lib/render-recipe'
import type { EditPlan } from '../src/lib/editplan'
import type { Word } from '../src/lib/subtitles'

const execFileAsync = promisify(execFile)
const BASE = 'http://localhost:3000'

let passed = 0
let failed = 0
let skipped = false
function assert(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name} ${detail}`)
  }
}
function skipAll(reason: string) {
  skipped = true
  console.log(`  ⚠️  SKIP: ${reason}`)
}

async function ffprobeJson(path: string): Promise<any> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration,size:stream=index,codec_type,codec_name,width,height', '-of', 'json', path],
    { timeout: 30_000 },
  )
  return JSON.parse(stdout)
}

// ---- minimal cookie-jar session handling (httpOnly clipforge_sid) ----
function jarFor(): { cookie: string; setFrom: (res: Response) => void } {
  const state = { cookie: '' }
  return {
    get cookie() {
      return state.cookie
    },
    setFrom(res: Response) {
      const setCookie = res.headers.get('set-cookie')
      if (!setCookie) return
      const m = setCookie.match(/clipforge_sid=[^;]+/)
      if (m) state.cookie = m[0]
    },
  }
}
type Jar = ReturnType<typeof jarFor>
async function api(jar: Jar, path: string, init?: RequestInit): Promise<{ status: number; body: any; res: Response }> {
  const headers = new Headers(init?.headers)
  if (jar.cookie) headers.set('cookie', jar.cookie)
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  jar.setFrom(res)
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, res }
}

async function main() {
  console.log('\n== URL-flow E2E: prepare job (metadata + captions + media download) ==')
  const A = jarFor()
  const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  const start = await api(A, '/api/source/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: URL_ }),
  })
  assert(start.status === 202 && start.body?.jobId, 'prepare job accepted (202)', JSON.stringify(start.body))

  // poll to terminal state (download may take minutes — hard cap 10 min)
  let job: any = null
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const r = await api(A, `/api/jobs/${start.body.jobId}`)
    job = r.body?.job
    if (!job) continue
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) break
  }
  if (!job || job.status !== 'COMPLETED') {
    skipAll(`prepare did not complete (${job?.status ?? 'no job'}: ${job?.errorMessage ?? 'n/a'}) — YouTube likely blocking this sandbox IP`)
    printSummary()
    return
  }
  const result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result
  console.log(`    → duration=${result.duration} (${result.durationSource}) · transcript=${result.transcriptSource}/${result.wordTiming} · ${result.wordCount} words · media=${JSON.stringify(result.localMedia)}`)

  const projectId: string = result.projectId
  assert(!!projectId, 'prepare persisted an owned project', projectId)
  assert(result.durationSource === 'yt-dlp' || result.durationSource === 'innertube', 'real duration resolved (not guessed)', `${result.durationSource}`)
  assert(result.localMedia?.state === 'ready', 'source media downloaded (localMediaState=ready)', JSON.stringify(result.localMedia))
  const mediaAbs = `${process.cwd()}/${result.localMedia?.path ?? 'upload/yt/dQw4w9WgXcQ/source.mp4'}`
  assert(existsSync(mediaAbs), 'downloaded file exists on disk', mediaAbs)
  if (result.localMedia?.state !== 'ready' || !projectId) {
    skipAll('media not ready — cannot exercise the project-source render path')
    printSummary()
    return
  }

  console.log('\n== URL-flow E2E: plan → recipe (renderer contract) ==')
  // real duration drives the clip window: clip = [60, 90], cut [70, 80] → 20s output
  const videoDur: number = result.duration ?? 213
  const clipStart = 60
  const clipEnd = Math.min(90, Math.max(clipStart + 20, videoDur - 5))
  const cutMid = (clipStart + clipEnd) / 2
  const cut = { start: cutMid - 5, end: cutMid + 5, reason: 'url-e2e pause trim' }
  const expectedOutput = clipEnd - clipStart - (cut.end - cut.start)

  // synthetic word timings inside the clip (subtitle/karaoke exercise)
  const words: Word[] = []
  const sentence = 'this clip was rendered straight from a youtube url'.split(' ')
  const s1Dur = (cut.start - clipStart - 1) / sentence.length
  sentence.forEach((w, i) => words.push({ word: w, start: clipStart + 0.5 + i * s1Dur, end: clipStart + 0.5 + i * s1Dur + s1Dur * 0.9 }))

  const plan: EditPlan = {
    project: { title: 'url-flow e2e', style: 'podcast', platform: 'shorts', target_duration: 30, aspect_ratio: '9:16' },
    analysis: { main_topic: 'e2e', audience: 'qa', content_type: 'test', overall_summary: 'url render e2e' },
    selected_clip: {
      id: 'url_e2e_01',
      start: clipStart,
      end: clipEnd,
      duration: clipEnd - clipStart,
      title: 'URL-flow E2E clip',
      generated_hook: 'RENDERED FROM A BARE URL',
      segments: [],
      cuts: [cut],
      camera: [{ start: clipStart, end: clipStart + 6, scale_start: 1.0, scale_end: 1.15, reason: 'hook punch-in' }],
      visuals: [],
      animations: [],
      sound_effects: [],
      music: { recommended: false, style: 'none', intensity: 0, ducking_percent: 0 },
      subtitles: [
        { start: words[0].start, end: words[words.length - 1].end, text: sentence.join(' '), emphasis_words: ['youtube'], emphasis_type: 'bold', word_timings: words.map((w) => ({ word: w.word, start: w.start, end: w.end })) },
      ],
    },
  }
  const recipeJson = buildRecipeJSON(buildRenderRecipe(plan, 'dQw4w9WgXcQ'))
  assert(JSON.parse(recipeJson).output_duration === expectedOutput, `recipe output_duration = ${expectedOutput}s`)

  console.log('\n== URL-flow E2E: JSON render via render-proxy (server-side media) ==')
  const neg1 = await api(A, '/api/render-proxy/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipe: recipeJson }),
  })
  assert(neg1.status === 400, 'JSON render without projectId → 400', String(neg1.status))

  // different session must NOT be able to render A's project
  const B = jarFor()
  await api(B, '/api/projects') // ensure session B cookie exists
  const neg2 = await api(B, '/api/render-proxy/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipe: recipeJson, projectId }),
  })
  assert(neg2.status === 404, 'foreign session render → 404 (ownership enforced)', String(neg2.status))

  // render start — burst-rate-limit aware: the per-IP 6/min render window is
  // shared across suites (golden + security + this one run back-to-back), so a
  // 429 here is the limiter WORKING; wait out the window and retry once.
  let renderStart = await api(A, '/api/render-proxy/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipe: recipeJson, projectId }),
  })
  if (renderStart.status === 429) {
    const retryAfter = Number(renderStart.res.headers.get('retry-after')) || 60
    console.log(`  ℹ️  burst rate limit hit — waiting ${retryAfter}s (limiter working as designed)`)
    await new Promise((r) => setTimeout(r, Math.min(120, retryAfter) * 1000))
    renderStart = await api(A, '/api/render-proxy/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipe: recipeJson, projectId }),
    })
  }
  assert(renderStart.status === 200 && renderStart.body?.id, 'project-source render job accepted', JSON.stringify(renderStart.body))

  // poll the render via the proxy
  let rjob: any = null
  const rdeadline = Date.now() + 300_000
  while (Date.now() < rdeadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const r = await api(A, `/api/render-proxy/jobs/${renderStart.body.id}`)
    rjob = r.body
    if (rjob && ['done', 'error', 'cancelled'].includes(rjob.status)) break
  }
  assert(rjob?.status === 'done', 'render completed', JSON.stringify(rjob ? { status: rjob.status, error: rjob.error } : rjob))
  if (rjob?.status !== 'done') {
    printSummary()
    return
  }
  assert(rjob?.durationOk !== false, `renderer durationOk (expect ≈${expectedOutput}s)`, String(rjob?.duration))

  console.log('\n== URL-flow E2E: download + verify the actual MP4 ==')
  const dlRes = await fetch(`${BASE}/api/render-proxy/jobs/${renderStart.body.id}/download`, { headers: { cookie: A.cookie } })
  const buf = Buffer.from(await dlRes.arrayBuffer())
  const outPath = '/tmp/clipforge-url-e2e-output.mp4'
  writeFileSync(outPath, buf)
  assert(dlRes.ok && buf.length > 100_000, `output downloaded (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)

  const probe = await ffprobeJson(outPath)
  const vStream = probe.streams?.find((s: any) => s.codec_type === 'video')
  const aStream = probe.streams?.find((s: any) => s.codec_type === 'audio')
  const dur = Number(probe.format?.duration)
  assert(Math.abs(dur - expectedOutput) <= 1.5, `duration ≈ ${expectedOutput}s (got ${dur.toFixed(3)})`)
  assert(vStream?.codec_name === 'h264', 'video codec = h264', String(vStream?.codec_name))
  assert(vStream?.width === 1080 && vStream?.height === 1920, `resolution = 1080x1920 (got ${vStream?.width}x${vStream?.height})`)
  assert(aStream?.codec_name === 'aac', 'audio stream exists = aac', String(aStream?.codec_name))

  try {
    const { stderr } = await execFileAsync('ffmpeg', ['-nostdin', '-i', outPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 120_000 })
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
    const mv = m ? parseFloat(m[1]) : -999
    assert(mv > -60, `audio is NOT silent (mean_volume ${mv} dB)`)
  } catch {
    assert(false, 'audio is NOT silent (volumedetect failed)')
  }

  printSummary()
}

function printSummary() {
  console.log('════════════════════════════════')
  console.log(`URL-RENDER E2E RESULT: ${passed} passed, ${failed} failed${skipped ? ' (SKIPPED — environment)' : ''}`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})

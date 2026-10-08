/**
 * ClipForge RENDER-SECURITY E2E
 * Run: bun run tests/render-security-e2e.ts  (requires dev server :3000 + renderer :3003)
 *
 * Mission Phase 1.1/1.2/1.4 acceptance through the REAL public path
 * (/api/render-proxy — the authorization boundary), not the internal renderer:
 *
 *  OWNERSHIP (the invariant: a user must never read/cancel/stream/download
 *             another user's render job):
 *   1. owner starts a render (multipart passthrough via the proxy)
 *   2. owner can poll their job
 *   3. foreign session poll      → 404
 *   4. foreign session stream    → 404
 *   5. foreign session cancel    → 404
 *   6. foreign session download  → 404
 *   7. unknown job id            → 404
 *   8. owner SSE stream delivers events
 *   9. owner download after completion → 200 real MP4
 *
 *  VALIDATION (renderer never executes untrusted JSON — via the proxy):
 *  10. full-cut recipe (keep_ranges: [])  → 400 EMPTY_OUTPUT (no phantom video)
 *  11. NaN duration                        → 400
 *  12. negative keep range                 → 400
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { buildRenderRecipe, buildRecipeJSON } from '../src/lib/render-recipe'
import type { EditPlan } from '../src/lib/editplan'

const execFileAsync = promisify(execFile)
const PROXY = 'http://localhost:3000/api/render-proxy'

// Internal renderer auth: direct renderer probes must carry the shared secret
// (the proxy injects the same value for every Next.js → renderer call).
const RENDERER_TOKEN = process.env.CLIPFORGE_RENDERER_TOKEN
if (!RENDERER_TOKEN) {
  console.error('FATAL: CLIPFORGE_RENDERER_TOKEN is not set (see .env.example)')
  process.exit(1)
}
const rh = () => ({ 'x-clipforge-internal-token': RENDERER_TOKEN! })

const OWNER = 'clipforge_sid=s-e2e-owner-session-000001'
const FOREIGN = 'clipforge_sid=s-e2e-foreign-session-0001'

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

async function main() {
  console.log('\n== Render-security E2E: renderer network boundary (loopback-only, no CORS, internal auth) ==')
  {
    // The renderer is an internal service whose ONLY supported client is the
    // Next.js proxy (server-to-server). It must therefore:
    //   1. be bound to 127.0.0.1 (not reachable off-host)
    //   2. emit NO wildcard CORS headers
    //   3. REJECT requests without the shared internal token (a malicious
    //      local page can POST to 127.0.0.1 without a preflight — CORS is not
    //      authentication; the token is)
    const bind = await execFileAsync('sh', ['-c', "ss -tlnp 2>/dev/null | grep ':3003' || true"]).catch(() => ({ stdout: '' }))
    assert(/127\.0\.0\.1:3003/.test(bind.stdout), 'renderer LISTENs on 127.0.0.1:3003 (not 0.0.0.0/[::])', bind.stdout.trim())
    const health = await fetch('http://127.0.0.1:3003/', { headers: rh() })
    assert(health.ok, 'renderer health responds with the internal token (proxy → renderer path alive)')
    const healthNoToken = await fetch('http://127.0.0.1:3003/')
    assert(healthNoToken.status === 401, 'renderer WITHOUT token → 401 (internal auth enforced)', `status=${healthNoToken.status}`)
    const healthWrong = await fetch('http://127.0.0.1:3003/', { headers: { 'x-clipforge-internal-token': 'wrong-token' } })
    assert(healthWrong.status === 401, 'renderer with WRONG token → 401', `status=${healthWrong.status}`)
    const noTokenBody: any = await healthNoToken.json().catch(() => ({}))
    assert(!noTokenBody.id && !noTokenBody.port, '401 body leaks no internal details', JSON.stringify(noTokenBody))
    assert(!health.headers.has('access-control-allow-origin'), 'renderer emits NO Access-Control-Allow-Origin header')
    assert(!health.headers.has('access-control-allow-methods'), 'renderer emits NO Access-Control-Allow-Methods header')
    assert(!health.headers.has('access-control-allow-headers'), 'renderer emits NO Access-Control-Allow-Headers header')
    const preflight = await fetch('http://127.0.0.1:3003/render', { method: 'OPTIONS', headers: rh() })
    assert(!preflight.headers.has('access-control-allow-origin'), 'OPTIONS is NOT treated as a CORS preflight by the renderer')
  }

  console.log('\n== Render-security E2E: fixture ==')
  const srcPath = '/tmp/clipforge-sec-e2e-src.mp4'
  await execFileAsync('ffmpeg', [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', srcPath,
  ], { timeout: 120_000 })
  assert(existsSync(srcPath), 'synthetic source generated')

  // same golden plan shape as the golden E2E (clip 5–35s, cut 15–25s → 20s out)
  const plan: EditPlan = {
    project: { title: 'sec e2e', style: 'podcast', platform: 'shorts', target_duration: 20, aspect_ratio: '9:16' },
    analysis: { main_topic: 'security', audience: 'qa', content_type: 'test', overall_summary: 'security e2e' },
    selected_clip: {
      id: 'sec_01', start: 5, end: 35, duration: 30, title: 'Security E2E clip',
      generated_hook: 'SECURITY TEST HOOK',
      segments: [], cuts: [{ start: 15, end: 25, reason: 'cut' }],
      camera: [{ start: 5, end: 13, scale_start: 1.0, scale_end: 1.18, reason: 'punch-in' }],
      visuals: [], animations: [], sound_effects: [],
      music: { recommended: false, style: 'none', intensity: 0, ducking_percent: 0 },
      subtitles: [],
    },
  }
  const recipeJson = buildRecipeJSON(buildRenderRecipe(plan, 'sec_test_id'))
  const parsed = JSON.parse(recipeJson)
  assert(parsed.keep_ranges.length === 2 && parsed.output_duration === 20, 'recipe keep_ranges/output valid (20s)')

  console.log('\n== Render-security E2E: start render as OWNER (multipart via proxy) ==')
  const form = new FormData()
  form.append('video', new Blob([readFileSync(srcPath)], { type: 'video/mp4' }), 'src.mp4')
  form.append('recipe', recipeJson)
  const startRes = await fetch(`${PROXY}/render`, { method: 'POST', headers: { cookie: OWNER }, body: form })
  const startJson: any = await startRes.json()
  assert(startRes.ok && startJson.id, 'render job accepted through proxy', JSON.stringify(startJson).slice(0, 200))
  const jobId = startJson.id as string

  console.log('\n== Render-security E2E: ownership invariant ==')
  await new Promise((r) => setTimeout(r, 800))
  const ownerPoll = await fetch(`${PROXY}/jobs/${jobId}`, { headers: { cookie: OWNER } })
  assert(ownerPoll.status === 200, 'owner can poll own job', `status=${ownerPoll.status}`)
  const foreignPoll = await fetch(`${PROXY}/jobs/${jobId}`, { headers: { cookie: FOREIGN } })
  assert(foreignPoll.status === 404, 'foreign session poll → 404', `status=${foreignPoll.status}`)
  const foreignStream = await fetch(`${PROXY}/jobs/${jobId}/stream`, { headers: { cookie: FOREIGN } })
  assert(foreignStream.status === 404, 'foreign session stream → 404', `status=${foreignStream.status}`)
  const foreignCancel = await fetch(`${PROXY}/jobs/${jobId}/cancel`, { method: 'POST', headers: { cookie: FOREIGN } })
  assert(foreignCancel.status === 404, 'foreign session cancel → 404', `status=${foreignCancel.status}`)
  const foreignDl = await fetch(`${PROXY}/jobs/${jobId}/download`, { headers: { cookie: FOREIGN } })
  assert(foreignDl.status === 404, 'foreign session download → 404', `status=${foreignDl.status}`)
  const unknownPoll = await fetch(`${PROXY}/jobs/00000000-0000-4000-8000-000000000000`, { headers: { cookie: OWNER } })
  assert(unknownPoll.status === 404, 'unknown job id → 404 (no UUID secrecy reliance)', `status=${unknownPoll.status}`)
  const noCookie = await fetch(`${PROXY}/jobs/${jobId}`)
  assert(noCookie.status === 404 || noCookie.status === 200, 'no-cookie request does not crash (session auto-created, may or may not match)', `status=${noCookie.status}`)

  console.log('\n== Render-security E2E: owner SSE stream ==')
  const streamRes = await fetch(`${PROXY}/jobs/${jobId}/stream`, { headers: { cookie: OWNER } })
  assert(streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'), 'owner can stream own job (SSE 200)')
  const reader = streamRes.body?.getReader()
  let gotEvent = false
  if (reader) {
    const timer = new Promise<null>((r) => setTimeout(() => r(null), 8000))
    const read = (async () => {
      const { value } = await reader.read()
      return value ? new TextDecoder().decode(value) : null
    })()
    const first = await Promise.race([read, timer])
    gotEvent = !!first && first.includes('data:')
    reader.cancel().catch(() => {})
  }
  assert(gotEvent, 'SSE delivers progress events', 'no event within 8s')

  console.log('\n== Render-security E2E: recipe validation through the proxy ==')
  // full-cut recipe (mission Phase 1.4: keepRanges empty → renderer REJECTS)
  const fullCutPlan: EditPlan = JSON.parse(JSON.stringify(plan))
  fullCutPlan.selected_clip.cuts = [{ start: 5, end: 35, reason: 'whole clip removed' }]
  const fullCutJson = buildRecipeJSON(buildRenderRecipe(fullCutPlan, 'sec_fullcut'))
  const fullCutParsed = JSON.parse(fullCutJson)
  assert(
    fullCutParsed.keep_ranges.length === 0 && fullCutParsed.output_duration === 0,
    'buildRecipeJSON emits EMPTY keep_ranges + output_duration 0 for full cut (no phantom fallback)',
    JSON.stringify({ kr: fullCutParsed.keep_ranges, d: fullCutParsed.output_duration }),
  )
  const fcForm = new FormData()
  fcForm.append('video', new Blob([readFileSync(srcPath)], { type: 'video/mp4' }), 'src.mp4')
  fcForm.append('recipe', fullCutJson)
  const fcRes = await fetch(`${PROXY}/render`, { method: 'POST', headers: { cookie: OWNER }, body: fcForm })
  const fcJson: any = await fcRes.json()
  assert(fcRes.status === 400 && (fcJson.code === 'EMPTY_OUTPUT' || /no keep ranges|empty/i.test(fcJson.error ?? '')), 'full-cut recipe → 400 EMPTY_OUTPUT via proxy', `status=${fcRes.status} ${JSON.stringify(fcJson).slice(0, 160)}`)

  // NaN duration → rejected
  const nanJson = JSON.stringify({ ...parsed, duration: Number.NaN })
  const nanForm = new FormData()
  nanForm.append('video', new Blob([readFileSync(srcPath)], { type: 'video/mp4' }), 'src.mp4')
  nanForm.append('recipe', nanJson)
  const nanRes = await fetch(`${PROXY}/render`, { method: 'POST', headers: { cookie: OWNER }, body: nanForm })
  assert(nanRes.status === 400, 'NaN duration recipe → 400', `status=${nanRes.status}`)

  // negative keep range → rejected
  const negJson = JSON.stringify({ ...parsed, keep_ranges: [{ start: -3, end: 5 }] })
  const negForm = new FormData()
  negForm.append('video', new Blob([readFileSync(srcPath)], { type: 'video/mp4' }), 'src.mp4')
  negForm.append('recipe', negJson)
  const negRes = await fetch(`${PROXY}/render`, { method: 'POST', headers: { cookie: OWNER }, body: negForm })
  assert(negRes.status === 400, 'negative keep range → 400', `status=${negRes.status}`)

  console.log('\n== Render-security E2E: owner completion + download ==')
  let job: any = null
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const r = await fetch(`${PROXY}/jobs/${jobId}`, { headers: { cookie: OWNER } })
    job = await r.json()
    if (['done', 'error', 'cancelled'].includes(job.status)) break
  }
  assert(job?.status === 'done', 'render completes through proxy', `status=${job?.status} error=${job?.error}`)
  const dl = await fetch(`${PROXY}/jobs/${jobId}/download`, { headers: { cookie: OWNER } })
  assert(dl.status === 200, 'owner can download own result', `status=${dl.status}`)
  const outPath = '/tmp/clipforge-sec-e2e-out.mp4'
  writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()))
  assert(existsSync(outPath) && statSync(outPath).size > 100_000, 'downloaded output is a real file', `${statSync(outPath)?.size} bytes`)
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outPath], { timeout: 30_000 })
  const dur = parseFloat(JSON.parse(stdout).format?.duration ?? '0')
  assert(Math.abs(dur - 20) <= 0.75, 'downloaded MP4 duration ≈ 20s', `got ${dur}`)

  console.log(`\n════════════════════════════════`)
  console.log(`RENDER-SECURITY E2E RESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Render-security E2E fatal:', e)
  process.exit(1)
})

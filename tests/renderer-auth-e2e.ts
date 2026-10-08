/// <reference types="bun-types" />
/**
 * ClipForge RENDERER-AUTH E2E — internal shared-secret authentication.
 * Run: bun run tests/renderer-auth-e2e.ts   (spawns its OWN isolated renderer;
 * no dependency on the shared :3003 instance — safe to run in CI and locally)
 *
 * The renderer performs EXPENSIVE work (FFmpeg). Loopback binding alone does
 * not stop a malicious local PAGE from POSTing to 127.0.0.1:3003 (a simple
 * cross-origin multipart POST needs no CORS preflight — the browser sends it
 * even though it cannot read the response). Every request must therefore
 * carry X-ClipForge-Internal-Token.
 *
 * Matrix (all against a REAL renderer process on an ephemeral port):
 *   1. fail-closed startup: no token configured anywhere → process exits(1)
 *   2. missing token                        → 401 (every endpoint)
 *   3. wrong token                          → 401
 *   4. correct token                        → normal response
 *   5. auth precedes job existence leakage  → 401 (not 404) for unknown ids
 *   6. auth precedes expensive work         → 401 POST /render never starts a
 *      job (no id returned); the subsequent CORRECTLY-authenticated render of
 *      the same tiny fixture completes normally and quickly
 *   7. EVERY renderer endpoint is protected:
 *      POST /render · GET /jobs/:id · GET /jobs/:id/stream ·
 *      POST /jobs/:id/cancel · GET /jobs/:id/download · GET /jobs/:id/cover
 *   8. happy path with token: tiny render → done → download + cover 200
 *      (a ~1.5s fixture — NO fake 1 GB render)
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRenderRecipe, buildRecipeJSON } from '../src/lib/render-recipe'
import type { EditPlan } from '../src/lib/editplan'

const PORT = 3555
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'renderer-auth-test-token-0123456789'
const TOKEN_HEADER = 'x-clipforge-internal-token'

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

/** Spawn an isolated renderer with the given environment. */
function spawnRenderer(env: Record<string, string>) {
  const child = spawn('bun', ['run', 'index.ts'], {
    cwd: join(import.meta.dir, '..', 'mini-services', 'ffmpeg-renderer'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return child
}

async function waitForRenderer(deadlineMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`, { headers: { [TOKEN_HEADER]: TOKEN } })
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  const workdir = mkdtempSync(join(tmpdir(), 'clipforge-auth-e2e-'))

  console.log('\n== Renderer-auth E2E: fail-closed startup (no token anywhere) ==')
  {
    const child = spawnRenderer({
      CLIPFORGE_RENDERER_TOKEN: '',
      CLIPFORGE_RENDERER_ENV_FILE: '/dev/null', // neutralize the repo-.env fallback → deterministic
      RENDERER_PORT: String(PORT + 1),
      RENDERER_WORKDIR: workdir,
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve(null) }, 15_000)
      child.on('exit', (c) => { clearTimeout(t); resolve(c) })
    })
    assert(code === 1, 'renderer exits(1) when CLIPFORGE_RENDERER_TOKEN is unset (fail closed)', `exit=${code}`)
    assert(/FATAL: CLIPFORGE_RENDERER_TOKEN is not set/.test(stderr), 'startup error is actionable (names the env var)', stderr.slice(0, 200))
    assert(!stderr.includes(TOKEN), 'startup error does not echo any token value')
  }

  console.log('\n== Renderer-auth E2E: start isolated renderer WITH the shared secret ==')
  const child = spawnRenderer({
    CLIPFORGE_RENDERER_TOKEN: TOKEN,
    RENDERER_PORT: String(PORT),
    RENDERER_WORKDIR: workdir,
  })
  let rendererStdout = ''
  child.stdout.on('data', (d) => { rendererStdout += d.toString() })
  child.stderr.on('data', (d) => { rendererStdout += d.toString() })
  try {
    const up = await waitForRenderer()
    assert(up, 'renderer comes up with token auth (health 200 with token)')

    console.log('\n== Renderer-auth E2E: auth matrix (every endpoint protected) ==')
    // health endpoint is protected too
    const healthNoToken = await fetch(`${BASE}/`)
    assert(healthNoToken.status === 401, 'GET / without token → 401', `status=${healthNoToken.status}`)
    const healthWrong = await fetch(`${BASE}/`, { headers: { [TOKEN_HEADER]: 'wrong-token' } })
    assert(healthWrong.status === 401, 'GET / with WRONG token → 401', `status=${healthWrong.status}`)
    const healthOk = await fetch(`${BASE}/`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert(healthOk.status === 200, 'GET / with correct token → 200', `status=${healthOk.status}`)

    // unknown job id: auth runs BEFORE job lookup → 401 (no existence leak)
    const UNKNOWN = '00000000-0000-4000-8000-000000000000'
    for (const [name, url, init] of [
      ['GET /jobs/:id', `${BASE}/jobs/${UNKNOWN}`, { method: 'GET' }],
      ['GET /jobs/:id/stream', `${BASE}/jobs/${UNKNOWN}/stream`, { method: 'GET' }],
      ['GET /jobs/:id/download', `${BASE}/jobs/${UNKNOWN}/download`, { method: 'GET' }],
      ['GET /jobs/:id/cover', `${BASE}/jobs/${UNKNOWN}/cover`, { method: 'GET' }],
      ['POST /jobs/:id/cancel', `${BASE}/jobs/${UNKNOWN}/cancel`, { method: 'POST' }],
    ] as const) {
      const noToken = await fetch(url, init as RequestInit)
      assert(noToken.status === 401, `${name} without token → 401 (not 404 — auth precedes job lookup)`, `status=${noToken.status}`)
      const wrong = await fetch(url, { ...init, headers: { [TOKEN_HEADER]: 'wrong-token' } } as RequestInit)
      assert(wrong.status === 401, `${name} with wrong token → 401`, `status=${wrong.status}`)
    }

    console.log('\n== Renderer-auth E2E: unauthenticated /render is rejected BEFORE expensive work ==')
    // valid-looking multipart body (tiny) — the request must be rejected by the
    // header check alone: no job id is ever returned, nothing is queued
    const tinyRecipe = JSON.stringify({ keep_ranges: [{ start: 0, end: 1 }], duration: 1, title: 'auth-probe' })
    const probeForm = new FormData()
    probeForm.append('video', new Blob([new Uint8Array(1024)], { type: 'video/mp4' }), 'probe.mp4')
    probeForm.append('recipe', tinyRecipe)
    const probeNoToken = await fetch(`${BASE}/render`, { method: 'POST', body: probeForm })
    const probeBody: any = await probeNoToken.json().catch(() => ({}))
    assert(probeNoToken.status === 401, 'POST /render without token → 401', `status=${probeNoToken.status}`)
    assert(!probeBody.id, 'rejected render returns NO job id (nothing was queued)', JSON.stringify(probeBody))
    const probeWrong = await fetch(`${BASE}/render`, { method: 'POST', body: probeForm, headers: { [TOKEN_HEADER]: 'wrong-token' } })
    assert(probeWrong.status === 401, 'POST /render with wrong token → 401', `status=${probeWrong.status}`)

    console.log('\n== Renderer-auth E2E: correctly authenticated render (tiny fixture, real ffmpeg) ==')
    // deterministic 1.5s fixture — small on purpose (NO fake 1 GB render)
    const srcPath = join(workdir, 'auth-src.mp4')
    const gen = Bun.spawnSync([
      'ffmpeg', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.5',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', srcPath,
    ])
    assert(gen.exitCode === 0 && (await Bun.file(srcPath).size) > 1000, 'tiny fixture generated (1.5s, 320x240)', `exit=${gen.exitCode}`)

    const plan: EditPlan = {
      project: { title: 'auth e2e', style: 'podcast', platform: 'shorts', target_duration: 1.5, aspect_ratio: '9:16' },
      analysis: { main_topic: 'auth', audience: 'qa', content_type: 'test', overall_summary: 'auth e2e' },
      selected_clip: {
        id: 'auth_01', start: 0, end: 1.5, duration: 1.5, title: 'auth e2e clip',
        generated_hook: 'AUTH E2E HOOK',
        segments: [], cuts: [],
        camera: [], visuals: [], animations: [], sound_effects: [],
        music: { recommended: false, style: 'none', intensity: 0, ducking_percent: 0 },
        subtitles: [],
      },
    }
    const recipeJson = buildRecipeJSON(buildRenderRecipe(plan, 'auth_test_id'), { coverTimestamp: 0.5 })

    const form = new FormData()
    form.append('video', new Blob([await Bun.file(srcPath).arrayBuffer()], { type: 'video/mp4' }), 'auth-src.mp4')
    form.append('recipe', recipeJson)
    const startRes = await fetch(`${BASE}/render`, { method: 'POST', body: form, headers: { [TOKEN_HEADER]: TOKEN } })
    const startJson: any = await startRes.json()
    assert(startRes.ok && startJson.id, 'correct token → render job accepted', JSON.stringify(startJson).slice(0, 200))
    const jobId = startJson.id as string

    let job: any = null
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700))
      const r = await fetch(`${BASE}/jobs/${jobId}`, { headers: { [TOKEN_HEADER]: TOKEN } })
      job = await r.json()
      if (['done', 'error', 'cancelled'].includes(job.status)) break
    }
    assert(job?.status === 'done', 'authenticated render completes', `status=${job?.status} error=${job?.error}`)
    assert(job?.durationOk === true, 'output duration matches recipe', `duration=${job?.duration}`)

    const dl = await fetch(`${BASE}/jobs/${jobId}/download`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert(dl.status === 200, 'download with correct token → 200', `status=${dl.status}`)
    const dlNoToken = await fetch(`${BASE}/jobs/${jobId}/download`)
    assert(dlNoToken.status === 401, 'download of a REAL finished artifact without token → 401', `status=${dlNoToken.status}`)
    const cover = await fetch(`${BASE}/jobs/${jobId}/cover`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert(cover.status === 200, 'cover with correct token → 200', `status=${cover.status}`)
    const coverNoToken = await fetch(`${BASE}/jobs/${jobId}/cover`)
    assert(coverNoToken.status === 401, 'cover without token → 401', `status=${coverNoToken.status}`)

    const cancel = await fetch(`${BASE}/jobs/${jobId}/cancel`, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN } })
    assert(cancel.ok, 'cancel with correct token → ok (terminal state is final)', `status=${cancel.status}`)

    // the SSE endpoint: correct token opens the stream; without token → 401
    const sse = await fetch(`${BASE}/jobs/${jobId}/stream`, { headers: { [TOKEN_HEADER]: TOKEN } })
    assert(sse.status === 200, 'SSE with correct token → 200', `status=${sse.status}`)
    await sse.body?.cancel().catch(() => {})
    const sseNoToken = await fetch(`${BASE}/jobs/${jobId}/stream`)
    assert(sseNoToken.status === 401, 'SSE without token → 401', `status=${sseNoToken.status}`)

    assert(!rendererStdout.includes(TOKEN), 'renderer logs never contain the token value')
  } finally {
    try { child.kill('SIGKILL') } catch {}
    try { rmSync(workdir, { recursive: true, force: true }) } catch {}
  }

  console.log(`\n════════════════════════════════`)
  console.log(`RENDERER-AUTH E2E RESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Renderer-auth E2E fatal:', e)
  process.exit(1)
})

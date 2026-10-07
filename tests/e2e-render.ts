/**
 * ClipForge GOLDEN END-TO-END RENDER TEST
 * Run: bun run tests/e2e-render.ts
 *
 * Pipeline exercised (real execution paths, no mocks):
 *   synthetic fixture video (ffmpeg testsrc2 + audible sine audio, 40s, 16:9 720p)
 *   → EditPlan (SOURCE timeline: clip 5–35s, cut 15–25s, camera punch-in, transcript words)
 *   → buildRenderRecipe (src/lib/render-recipe.ts — the renderer contract)
 *   → buildRecipeJSON (keep ranges + OUTPUT-time camera + OUTPUT-time ASS subs)
 *   → POST multipart to ffmpeg-renderer mini-service (port 3003)
 *   → poll job → download MP4
 *   → ffprobe/volumedetect assertions on the ACTUAL OUTPUT FILE
 *
 * Assertions:
 *   1. job completes (no silent-failure masking)
 *   2. output file exists & non-trivial size
 *   3. output duration ≈ expected (30s clip − 10s cut = 20s, tolerance 0.75s)
 *   4. video stream = 1080x1920 h264 (9:16, no aspect distortion from zoompan)
 *   5. audio stream exists = aac and is NOT silent (mean_volume > -60dB)
 *   6. ASS subtitle events all within [0, outputDuration] (OUTPUT time)
 *   7. renderer's own durationOk flag true
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { buildRenderRecipe, buildRecipeJSON, generateASS } from '../src/lib/render-recipe'
import type { EditPlan } from '../src/lib/editplan'
import type { Word } from '../src/lib/subtitles'

const execFileAsync = promisify(execFile)
const RENDERER = 'http://localhost:3003'

const CLIP_START = 5
const CLIP_END = 35
const CUT = { start: 15, end: 25, reason: 'silence — golden test' }
const EXPECTED_OUTPUT = CLIP_END - CLIP_START - (CUT.end - CUT.start) // 20s

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

async function ffprobeJson(path: string): Promise<any> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration,size:stream=index,codec_type,codec_name,width,height', '-of', 'json', path],
    { timeout: 30_000 },
  )
  return JSON.parse(stdout)
}

async function meanVolume(path: string): Promise<number> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', ['-nostdin', '-i', path, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 60_000 })
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
    return m ? parseFloat(m[1]) : -999
  } catch (e: any) {
    return -999
  }
}

async function main() {
  console.log('\n== Golden E2E: fixture generation ==')
  const srcPath = '/tmp/clipforge-e2e-src.mp4'
  // 40s 1280x720 with a moving pattern + 440Hz sine tone (clearly audible)
  await execFileAsync('ffmpeg', [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', srcPath,
  ], { timeout: 120_000 })
  assert(existsSync(srcPath), 'synthetic source generated (40s, 1280x720, testsrc2+sine)')

  console.log('\n== Golden E2E: plan → recipe (renderer contract) ==')
  // transcript-grounded words inside the clip window (SOURCE time), none inside the cut
  const sentence1 = 'this is the golden end to end render test'.split(' ')
  const sentence2 = 'the cut in the middle must disappear completely'.split(' ')
  const words: Word[] = []
  sentence1.forEach((w, i) => words.push({ word: w, start: CLIP_START + 0.5 + i * 0.45, end: CLIP_START + 0.5 + i * 0.45 + 0.4 }))
  sentence2.forEach((w, i) => words.push({ word: w, start: 25.5 + i * 0.45, end: 25.5 + i * 0.45 + 0.4 }))

  const plan: EditPlan = {
    project: { title: 'golden e2e', style: 'podcast', platform: 'shorts', target_duration: 20, aspect_ratio: '9:16' },
    analysis: { main_topic: 'e2e', audience: 'qa', content_type: 'test', overall_summary: 'golden test' },
    selected_clip: {
      id: 'golden_01',
      start: CLIP_START,
      end: CLIP_END,
      duration: CLIP_END - CLIP_START,
      title: 'Golden E2E clip',
      generated_hook: 'GOLDEN TEST HOOK',
      segments: [],
      cuts: [CUT],
      // one punch-in in SOURCE time: 1.0 → 1.18 across the kept range start
      camera: [{ start: CLIP_START, end: CLIP_START + 8, scale_start: 1.0, scale_end: 1.18, reason: 'hook punch-in' }],
      visuals: [],
      animations: [],
      sound_effects: [],
      music: { recommended: false, style: 'none', intensity: 0, ducking_percent: 0 },
      // SOURCE-time subtitle blocks built from the real words + karaoke timings
      subtitles: [
        { start: sentence1[0] ? words[0].start : 0, end: words[sentence1.length - 1].end, text: sentence1.join(' '), emphasis_words: ['golden'], emphasis_type: 'bold', word_timings: words.slice(0, sentence1.length).map((w) => ({ word: w.word, start: w.start, end: w.end })) },
        { start: words[sentence1.length].start, end: words[words.length - 1].end, text: sentence2.join(' '), emphasis_words: [], emphasis_type: 'bold', word_timings: words.slice(sentence1.length).map((w) => ({ word: w.word, start: w.start, end: w.end })) },
      ],
    },
  }

  const recipe = buildRenderRecipe(plan, 'golden_test_id')
  const recipeJson = buildRecipeJSON(recipe)
  const parsed = JSON.parse(recipeJson)

  assert(eq(parsed.output_duration, EXPECTED_OUTPUT), `recipe output_duration = ${EXPECTED_OUTPUT}s`, `got ${parsed.output_duration}`)
  const keep = parsed.keep_ranges
  assert(keep.length === 2 && eq(keep[0].end - keep[0].start, 10) && eq(keep[1].end - keep[1].start, 10), 'keep ranges [5-15],[25-35]', JSON.stringify(keep))
  assert(parsed.camera_keyframes.every((k: any) => k.time >= 0 && k.time <= EXPECTED_OUTPUT + 0.01), 'camera keyframes pre-mapped into OUTPUT time', JSON.stringify(parsed.camera_keyframes))

  // ASS sanity (pre-render): all events within output duration, no event in removed range
  const ass = generateASS(recipe)
  const events = [...ass.matchAll(/Dialogue: \d+,([\d:.]+),([\d:.]+),/g)].map((m) => ({ s: assTimeToSec(m[1]), e: assTimeToSec(m[2]) }))
  assert(events.length >= 2, `ASS has events (${events.length})`)
  assert(events.every((ev) => ev.e <= EXPECTED_OUTPUT + 0.05), 'all ASS events end within output duration', JSON.stringify(events))
  assert(ass.includes('\\k'), 'karaoke word-highlight (\\k tags) present in ASS (real word timings)', ass.split('\n').find((l) => l.startsWith('Dialogue: 0')) ?? '')
  writeFileSync('/tmp/clipforge-e2e.expected.ass', ass)

  console.log('\n== Golden E2E: render via ffmpeg-renderer mini-service ==')
  const form = new FormData()
  const fileBuf = readFileSync(srcPath)
  form.append('video', new Blob([fileBuf], { type: 'video/mp4' }), 'src.mp4')
  form.append('recipe', recipeJson)
  const startRes = await fetch(`${RENDERER}/render`, { method: 'POST', body: form })
  const startJson: any = await startRes.json()
  assert(startRes.ok && startJson.id, 'render job accepted', JSON.stringify(startJson))

  // poll until terminal state
  let job: any = null
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200))
    const r = await fetch(`${RENDERER}/jobs/${startJson.id}`)
    job = await r.json()
    if (['done', 'error', 'cancelled'].includes(job.status)) break
  }
  assert(job && job.status === 'done', 'render job completes (status=done)', `status=${job?.status} error=${job?.error}`)
  assert(job?.durationOk === true, 'renderer duration check durationOk=true', `duration=${job?.duration} vs ${EXPECTED_OUTPUT}`)

  console.log('\n== Golden E2E: output file validation (ffprobe / volumedetect) ==')
  const dl = await fetch(`${RENDERER}/jobs/${startJson.id}/download`)
  assert(dl.ok, 'download endpoint returns 200', `status=${dl.status}`)
  const outPath = '/tmp/clipforge-e2e-out.mp4'
  writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()))
  assert(existsSync(outPath) && statSync(outPath).size > 100_000, 'output file exists and has real size', `${statSync(outPath)?.size} bytes`)

  const probe = await ffprobeJson(outPath)
  const outDur = parseFloat(probe.format?.duration ?? '0')
  assert(Math.abs(outDur - EXPECTED_OUTPUT) <= 0.75, `output duration ≈ ${EXPECTED_OUTPUT}s`, `got ${outDur}`)
  const v = (probe.streams ?? []).find((s: any) => s.codec_type === 'video')
  const a = (probe.streams ?? []).find((s: any) => s.codec_type === 'audio')
  assert(v?.codec_name === 'h264', 'video codec = h264', `got ${v?.codec_name}`)
  assert(v?.width === 1080 && v?.height === 1920, 'resolution = 1080x1920 (9:16, undistorted with zoom active)', `got ${v?.width}x${v?.height}`)
  assert(a?.codec_name === 'aac', 'audio stream exists = aac', `got ${a?.codec_name}`)
  const mv = await meanVolume(outPath)
  assert(mv > -60, 'audio is NOT silent (mean_volume > -60dB)', `mean_volume=${mv}dB`)

  console.log(`\n════════════════════════════════`)
  console.log(`GOLDEN E2E RESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

function eq(a: unknown, b: unknown, eps = 0.05): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < eps
  return a === b
}

/** libass H:MM:SS.cc → seconds */
function assTimeToSec(t: string): number {
  const m = t.match(/(\d+):(\d+):(\d+)\.(\d+)/)
  if (!m) return NaN
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4].padEnd(2, '0')) / 100
}

main().catch((e) => {
  console.error('E2E fatal:', e)
  process.exit(1)
})

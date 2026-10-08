// ClipForge AI — renderer supervisor (self-healing mini-service lifecycle)
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// The ffmpeg-renderer (mini-services/ffmpeg-renderer, port 3003) is a separate
// long-lived process. In sandboxed/containerized deployments the renderer can
// be killed by process-reaping between tool sessions (only init-owned daemons
// survive). This supervisor makes the render path SELF-HEALING: when a request
// arrives and the renderer is unreachable, the Next.js server (a long-lived
// init-owned process itself) spawns it detached and waits for readiness.
//
// Spawn contract:
//   - `spawn(..., { detached: true, stdio: 'ignore' }).unref()` → the child is
//     re-parented to init when the parent exits; it never receives tool-session
//     cleanup signals because it is NOT a member of any tool session's process
//     group (setsid via detached:true).
//   - Renderer binds 127.0.0.1 only (see mini-services/ffmpeg-renderer/index.ts)
//     — spawning it from here does not change its network boundary.
//
// Concurrency: multiple requests can race to start the renderer. A module-level
// singleton promise guarantees exactly one spawn attempt at a time; losers wait
// on the same readiness check.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER_BASE = process.env.RENDERER_BASE_URL ?? 'http://127.0.0.1:3003'
const RENDERER_DIR = join(process.cwd(), 'mini-services', 'ffmpeg-renderer')
const HEALTH_TIMEOUT_MS = 20_000 // max wait for the renderer to come up
const START_POLL_MS = 400 // poll interval while waiting

let healthCache: { ok: boolean; at: number } | null = null
const HEALTH_TTL_MS = 5_000 // cache "ok" for 5s to avoid a TCP round-trip per poll
let starting: Promise<boolean> | null = null

/** Cheap renderer health probe (cached briefly when healthy). */
async function isRendererUp(): Promise<boolean> {
  if (healthCache && healthCache.ok && Date.now() - healthCache.at < HEALTH_TTL_MS) {
    return true
  }
  try {
    const res = await fetch(`${RENDERER_BASE}/`, {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    })
    const ok = res.ok
    healthCache = { ok, at: Date.now() }
    return ok
  } catch {
    healthCache = { ok: false, at: Date.now() }
    return false
  }
}

/** Spawn the renderer detached from this process (survives parent exit). */
function spawnRenderer(): boolean {
  if (!existsSync(join(RENDERER_DIR, 'index.ts'))) {
    console.error('[renderer-supervisor] index.ts not found at', RENDERER_DIR)
    return false
  }
  try {
    // `bun run dev` → `bun --hot run index.ts` (hot-reload dev entry, matches
    // the documented mini-service contract). detached → new session (setsid),
    // stdio ignore → no pipe backpressure, unref → parent may exit freely.
    const child = spawn('bun', ['run', 'dev'], {
      cwd: RENDERER_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, RENDERER_FROM_SUPERVISOR: '1' },
    })
    child.unref()
    console.log('[renderer-supervisor] spawned ffmpeg-renderer (pid', child.pid + ')')
    return true
  } catch (err) {
    console.error('[renderer-supervisor] spawn failed:', err)
    return false
  }
}

/**
 * Ensure the ffmpeg-renderer is reachable; start it (once, lazily) if it is
 * down. Safe to call on every render-proxy request.
 * @returns true when the renderer answered the health probe.
 */
export async function ensureRenderer(): Promise<boolean> {
  if (await isRendererUp()) return true
  if (starting) return starting
  starting = (async () => {
    // double-check inside the single-flight promise (another waiter may have
    // just brought it up)
    if (await isRendererUp()) return true
    if (!spawnRenderer()) return false
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, START_POLL_MS))
      if (await isRendererUp()) return true
    }
    console.error('[renderer-supervisor] renderer did not become healthy within', HEALTH_TIMEOUT_MS, 'ms')
    return false
  })().finally(() => {
    starting = null
  })
  return starting
}

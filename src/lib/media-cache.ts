import { existsSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Media cache hygiene for `upload/yt/<youtubeId>/` (downloaded YouTube sources).
 *
 * Every cached source is 10–300 MB; without a bound, the library grows forever.
 * This module implements a simple, honest LRU policy:
 *
 *   - `touchMediaCache(id)`      record last-use time (throttled in-memory)
 *   - `pruneMediaCache()`        if total size exceeds the cap, evict
 *                                least-recently-used directories until under cap
 *
 * Design rules (same discipline as the rest of the pipeline):
 *   - PURE planner (`planMediaCacheEviction`) + thin fs executor — unit-testable.
 *   - The cap is env-configurable (`CLIPFORGE_MEDIA_CACHE_MB`, default 2048;
 *     0 disables pruning — an explicit operator decision, also documented in
 *     .env.example).
 *   - Recently-touched directories are PROTECTED (default 10 min) so an active
 *     download / in-flight render is never evicted mid-job.
 *   - Eviction is best-effort: errors on individual directories are logged and
 *     skipped, never thrown into the download path.
 *   - The CALLER is responsible for DB truth: `pruneMediaCache` returns the
 *     evicted ids so callers can mark affected projects `localMediaState=
 *     'unavailable'` instead of leaving dangling paths.
 */

export const MEDIA_CACHE_LRU_FILE = '.lru.json'

/** Cache cap in bytes from env (default 2048 MB; 0 = unlimited). */
export function mediaCacheCapBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLIPFORGE_MEDIA_CACHE_MB
  if (raw === undefined || raw === '') return 2048 * 1024 * 1024
  const n = Number(raw)
  if (!isFinite(n) || n < 0) return 2048 * 1024 * 1024
  return Math.round(n * 1024 * 1024)
}

/** Protection window: directories touched within this window are never evicted. */
export const MEDIA_CACHE_PROTECT_MS = 10 * 60_000

export interface CacheEntry {
  id: string
  sizeBytes: number
  lastUsed: number // epoch ms
}

export interface EvictionPlan {
  evictIds: string[] // in LRU order (oldest use first)
  totalBytes: number
  projectedBytes: number // total minus evicted
  capBytes: number
}

/**
 * Pure LRU eviction planner.
 * Evicts oldest-lastUsed entries until projected total <= cap.
 * Entries newer than `protectMs` (relative to `now`) are never evicted.
 */
export function planMediaCacheEviction(
  entries: CacheEntry[],
  capBytes: number,
  now: number,
  protectMs: number = MEDIA_CACHE_PROTECT_MS,
): EvictionPlan {
  const totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0)
  if (capBytes <= 0 || totalBytes <= capBytes) {
    return { evictIds: [], totalBytes, projectedBytes: totalBytes, capBytes }
  }
  const sorted = [...entries].sort((a, b) => a.lastUsed - b.lastUsed)
  let projected = totalBytes
  const evictIds: string[] = []
  for (const e of sorted) {
    if (projected <= capBytes) break
    if (now - e.lastUsed < protectMs) continue // protected: active download/render
    evictIds.push(e.id)
    projected -= e.sizeBytes
  }
  return { evictIds, totalBytes, projectedBytes: projected, capBytes }
}

/** Read the LRU hints file (missing/corrupt → {}). */
function readLruMap(uploadYtDir: string): Record<string, number> {
  try {
    const raw = readFileSync(join(uploadYtDir, MEDIA_CACHE_LRU_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v)
        if (isSafeCacheId(k) && isFinite(n) && n > 0) out[k] = n
      }
      return out
    }
  } catch { /* missing or corrupt → empty */ }
  return {}
}

function writeLruMap(uploadYtDir: string, map: Record<string, number>): void {
  try {
    writeFileSync(join(uploadYtDir, MEDIA_CACHE_LRU_FILE), JSON.stringify(map), { flag: 'w' })
  } catch { /* best effort */ }
}

/** Strict id check — youtube ids become filesystem paths. */
export function isSafeCacheId(id: string): boolean {
  return /^[-A-Za-z0-9_]{4,40}$/.test(id)
}

// in-memory write throttle: one fs write per id per minute is plenty for an LRU hint
const touchThrottle = new Map<string, number>()
const TOUCH_THROTTLE_MS = 60_000

/**
 * Record a use of `youtubeId` media (download completion, media stream, render).
 * Throttled in-memory (1 write/min/id); corrupt-safe; never throws.
 */
export function touchMediaCache(youtubeId: string, now: number = Date.now()): void {
  if (!isSafeCacheId(youtubeId)) return
  const last = touchThrottle.get(youtubeId) ?? 0
  if (now - last < TOUCH_THROTTLE_MS) return
  touchThrottle.set(youtubeId, now)
  const dir = join(process.cwd(), 'upload', 'yt')
  if (!existsSync(dir)) return
  const map = readLruMap(dir)
  map[youtubeId] = now
  writeLruMap(dir, map)
}

/** Size of a directory in bytes (files only, non-recursive-unsafe: one level). */
function dirSizeBytes(dir: string): number {
  let total = 0
  try {
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f))
        if (st.isFile()) total += st.size
      } catch { /* raced delete */ }
    }
  } catch { /* missing dir */ }
  return total
}

export interface PruneResult {
  plan: EvictionPlan
  evicted: string[] // ids actually removed from disk
  failed: string[] // ids that errored during removal (logged, not thrown)
}

/**
 * Enforce the cache cap on `upload/yt/`. Best-effort; never throws.
 * Caller should mark projects of `evicted` ids as `localMediaState='unavailable'`.
 */
export function pruneMediaCache(now: number = Date.now()): PruneResult {
  const capBytes = mediaCacheCapBytes()
  const uploadYtDir = join(process.cwd(), 'upload', 'yt')
  const empty: PruneResult = {
    plan: { evictIds: [], totalBytes: 0, projectedBytes: 0, capBytes },
    evicted: [],
    failed: [],
  }
  if (capBytes <= 0 || !existsSync(uploadYtDir)) return empty

  const lru = readLruMap(uploadYtDir)
  const entries: CacheEntry[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(uploadYtDir).filter((d) => isSafeCacheId(d))
  } catch {
    return empty
  }
  for (const id of dirs) {
    const dir = join(uploadYtDir, id)
    let mtime = 0
    try {
      mtime = statSync(dir).mtimeMs
    } catch { /* raced delete */ }
    entries.push({ id, sizeBytes: dirSizeBytes(dir), lastUsed: lru[id] ?? mtime })
  }

  const plan = planMediaCacheEviction(entries, capBytes, now)
  if (plan.evictIds.length === 0) return { plan, evicted: [], failed: [] }

  const evicted: string[] = []
  const failed: string[] = []
  for (const id of plan.evictIds) {
    try {
      rmSync(join(uploadYtDir, id), { recursive: true, force: true })
      evicted.push(id)
      touchThrottle.delete(id)
    } catch {
      failed.push(id)
    }
  }
  // keep the LRU map clean (best effort)
  if (evicted.length > 0) {
    const map = readLruMap(uploadYtDir)
    for (const id of evicted) delete map[id]
    writeLruMap(uploadYtDir, map)
  }
  return { plan, evicted, failed }
}

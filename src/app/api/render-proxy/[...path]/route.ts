import { NextRequest, NextResponse } from 'next/server'
import { statSync, existsSync, rmSync } from 'node:fs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { checkRateLimit } from '@/lib/validation'
import { getOrCreateSessionId } from '@/lib/session'
import { recordUsage } from '@/lib/usage'
import { mediaMimeForExt, resolveLocalMediaPath } from '@/lib/media'
import { touchMediaCache } from '@/lib/media-cache'
import { checkDailyUsageLimit, limitHeaders, limitReachedMessage } from '@/lib/usage-limits'
import { ensureRenderer } from '@/lib/renderer-supervisor'

// Proxy from /api/render-proxy/[...path] to the ffmpeg-renderer mini-service at 127.0.0.1:3003
// Keeps the mini-service internal (never publicly exposed).
//
// ─── SECURITY: JOB OWNERSHIP (10/10 mission, Phase 1.1) ─────────────────────
// Every job operation (poll, SSE stream, cancel, download, cover frame) is
// AUTHORIZED here against the RenderJob table BEFORE touching the renderer:
//   POST /render  → records (jobId, ownerId, projectId) on success
//   POST /jobs/:id/cancel   → 404 unless the row exists AND ownerId matches
//   POST /jobs/:id/pin      → 404 unless owned (pin/unpin a DONE artifact)
//   GET  /jobs/:id          → 404 unless owned
//   GET  /jobs/:id/stream   → 404 unless owned
//   GET  /jobs/:id/download → 404 unless owned
//   GET  /jobs/:id/cover    → 404 unless owned
//   GET  /archive           → ZIP of owned DONE artifacts (manifest-validated,
//                             direct-FS — no renderer dependency)
// Random UUID secrecy is NEVER relied on; ownership lives in the DB.
// The renderer is a trusted internal service (localhost only); this proxy is
// the public-facing authorization boundary.
//
// ─── INTERNAL RENDERER AUTHENTICATION (shared secret) ─────────────────────
// The renderer authenticates EVERY proxy request with the shared secret
// CLIPFORGE_RENDERER_TOKEN (header: x-clipforge-internal-token). The token is
// attached to EVERY Next.js → renderer fetch (render start, poll, SSE,
// cancel, download, cover, AND the ownership-failure cancel) — never to any
// browser-facing response, log, or error message. If the variable is not
// configured on the Next.js side, requests fail closed with an honest 500
// (the renderer would reject them with 401 anyway).
//
// Two input modes for renders (POST /render):
//   1. multipart passthrough — the client uploads the source video (Upload tab)
//   2. JSON { recipe, projectId } — the renderer input is the server-side media
//      persisted on the owned project (downloaded YouTube source / upload kept
//      by the transcribe job). The proxy resolves the path FROM THE DB (the
//      client NEVER sends a path), validates ownership + path containment, and
//      STREAMS the file into a manually-built multipart body (no 1.5 GB RAM
//      buffer) — the renderer contract is unchanged.
//
// ─── MEMORY SAFETY (both directions) ─────────────────────────────────────────
//   Upload:  browser → ReadableStream (byte-capped) → this proxy → renderer
//            The multipart body is NEVER materialized via req.blob()/
//            req.arrayBuffer(); an 8 MB-capped byte counter enforces the size
//            limit DURING streaming (also covers chunked uploads that omit
//            Content-Length, where a declared-length precheck is impossible).
//   Download: renderer → stream → this proxy → browser. MP4/cover responses
//            are piped through, never buffered (no 500 MB arrayBuffer()).

const RENDERER_BASE = 'http://127.0.0.1:3003'

// Shared secret with the ffmpeg-renderer mini-service (server-side only).
const RENDERER_TOKEN = process.env.CLIPFORGE_RENDERER_TOKEN ?? ''
const TOKEN_HEADER = 'x-clipforge-internal-token'

/** Headers for EVERY Next.js → renderer fetch: the internal shared secret.
 * Centralized so no renderer call site can forget it. */
function rendererHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [TOKEN_HEADER]: RENDERER_TOKEN, ...extra }
}

// resource limits (mission Phase 1.3) — mirror the renderer's own guards
const MAX_SOURCE_BYTES = 1500 * 1024 * 1024 // 1.5 GB
const MAX_RECIPE_BYTES = 1024 * 1024 // 1 MiB (matches renderer validation)
const STREAM_CHUNK = 8 * 1024 * 1024 // 8 MB streaming chunks

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const JOB_PATH_RE = /^\/jobs\/([\w-]+)(\/(stream|download|cover|cancel))?$/
// statuses that mean "the renderer should still know this job" — used by the
// stale-row reconciliation (a 404 for an ACTIVE row = the job is lost)
const ACTIVE_STATUSES = new Set(['QUEUED', 'EXTRACTING', 'RENDERING', 'FINALIZING'])
// mirrors the renderer's SAFE_MP4_NAME — manifests are trusted, but the
// direct-FS pin fallback validates anyway (defense in depth)
const SAFE_MP4_NAME = /^clipforge_[A-Za-z0-9_-]{0,60}\.mp4$/

/**
 * GET /api/render-proxy/jobs — render history for THIS session (owner-scoped).
 *
 * Lists the caller's RenderJob rows newest-first and RECONCILES them against
 * the live renderer before answering (via reconcileActiveRow):
 *   - active row + renderer knows it → sync terminal/progress status into the row
 *   - active row + renderer 404      → the renderer restarted since the job
 *     started; its in-memory job is gone. The row is honestly marked ERROR
 *     ("render lost — render again") instead of staying stuck active forever.
 *   - DONE rows keep their recorded state (artifacts may still be within the
 *     renderer's retention window — download is attempted live by the client).
 *
 * This is the data source for the UI Render History panel and doubles as the
 * stale-row reaper documented in the deployment worklog (plus the global
 * sweepStaleActiveRows pass for abandoned sessions).
 */
/** Reconcile an ACTIVE row against the live renderer (owner-agnostic).
 * Used both by the owner-scoped history list AND by the global stale sweep —
 * same rules: renderer knows the job → sync its real status; renderer 404 →
 * the job is lost (restart) → honest ERROR. Never touches rows the renderer
 * still considers active (another session's live render is NOT stale). */
async function reconcileActiveRow(row: { id: string; status: string }): Promise<void> {
  try {
    const res = await fetch(`${RENDERER_BASE}/jobs/${row.id}`, {
      headers: rendererHeaders(),
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    })
    if (res.ok) {
      const j = (await res.json()) as { status?: unknown; stage?: unknown; filename?: unknown }
      const status = canonicalStatus(j.status)
      if (status && status !== row.status) {
        await db.renderJob.update({
          where: { id: row.id },
          data: {
            status,
            ...(typeof j.stage === 'string' ? { stage: j.stage.slice(0, 300) } : {}),
            ...(typeof j.filename === 'string' && j.filename ? { filename: j.filename.slice(0, 255) } : {}),
          },
        })
      }
    } else if (res.status === 404) {
      await db.renderJob.update({
        where: { id: row.id },
        data: {
          status: 'ERROR',
          stage: 'Render job lost — the render service restarted. Please render again.',
        },
      })
    }
  } catch {
    // renderer unreachable — keep the recorded status (supervisor revives on demand)
  }
}

/** Global stale-row sweep: ACTIVE RenderJob rows abandoned by sessions that
 * stopped polling (closed tab, dead browser) would otherwise sit QUEUED/
 * RENDERING forever — reconciliation is owner-triggered and the owner is gone.
 * Any history-list call sweeps a bounded window of rows older than 20 minutes
 * (ALL owners — the renderer answers status for any job id, owner-free). */
const STALE_ROW_AGE_MS = 20 * 60_000
async function sweepStaleActiveRows(): Promise<void> {
  try {
    const stale = await db.renderJob.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        updatedAt: { lt: new Date(Date.now() - STALE_ROW_AGE_MS) },
      },
      select: { id: true, status: true },
      take: 10,
    })
    if (stale.length > 0) {
      await Promise.all(stale.map((row) => reconcileActiveRow(row)))
    }
  } catch {
    // sweep is best-effort observability — never break the list response
  }
}

/** Ancient-row prune (round-5 housekeeping): RenderJob rows accumulate forever
 * for sessions that never return (closed browsers lose the cookie — the rows
 * are invisible to every future owner). After 7 days:
 *   - ERROR/CANCELLED rows have no artifacts by definition → delete outright
 *   - DONE rows are deleted ONLY when the renderer confirms the artifact is
 *     gone (404) — a pinned or still-within-cap artifact keeps its row (the
 *     download link must keep working); an unreachable renderer keeps rows
 *     (cannot verify — never delete on a guess)
 * Bounded (take 10 per call), best-effort, all owners. */
const ANCIENT_ROW_AGE_MS = 7 * 24 * 3600_000
async function pruneAncientRows(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ANCIENT_ROW_AGE_MS)
    // terminal rows with no artifacts by definition
    const dead = await db.renderJob.deleteMany({
      where: { status: { in: ['ERROR', 'CANCELLED'] }, updatedAt: { lt: cutoff } },
    })
    // DONE rows — verify the artifact is really gone before dropping the row
    const oldDone = await db.renderJob.findMany({
      where: { status: 'DONE', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: 10,
    })
    const gone: string[] = []
    await Promise.all(
      oldDone.map(async (row) => {
        try {
          const res = await fetch(`${RENDERER_BASE}/jobs/${row.id}`, {
            headers: rendererHeaders(),
            signal: AbortSignal.timeout(4000),
            cache: 'no-store',
          })
          if (res.status === 404) gone.push(row.id)
          // ok → artifact alive (pinned or within cap) — keep the row
          // network error → unverifiable — keep the row
        } catch {
          // unreachable — keep (never delete on a guess)
        }
      }),
    )
    let doneRemoved = 0
    for (const id of gone) {
      try {
        await db.renderJob.delete({ where: { id } })
        doneRemoved++
      } catch {
        // already gone — fine
      }
    }
    if (dead.count > 0 || doneRemoved > 0) {
      console.log(`[render-proxy] ancient-row prune: removed ${dead.count} terminal row(s) + ${doneRemoved} artifact-less DONE row(s)`)
    }
  } catch {
    // best-effort housekeeping — never break the list response
  }
}

// ─── GET /archive — "download all" ZIP of this session's finished renders ────
// Streams a STORE-method (uncompressed) ZIP built from the PERSISTED artifact
// store (upload/renders/<jobId>/manifest.json + clipforge_*.mp4) — read
// directly from disk, NO renderer dependency (same economy as pin/delete: a
// bulk download must never revive a dead service). Ownership is enforced via
// the RenderJob table exactly like every other job operation.
//
// ZIP writer notes (why hand-rolled): MP4s are already-compressed media —
// deflate would burn CPU for ~0% size win, so entries use method 0 (STORE).
// CRC-32 is computed incrementally per 8 MB chunk and emitted in a per-entry
// data descriptor (flag bit 3) after the file data — the standard streaming
// ZIP layout (local header CRC/size fields are zero; the CENTRAL directory
// carries the real values, which is what every unzip tool actually reads).
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB of MP4 payload per archive
const MAX_ARCHIVE_ENTRIES = 50

/** CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — small table impl so the
 *  route works on every runtime (node:zlib.crc32 is version-gated). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < chunk.length; i++) {
    c = (CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

/** DOS date/time words from a JS Date (ZIP's 1980-based 2s-resolution format). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  return { time, date }
}

interface ArchiveEntry {
  name: string
  path: string
  size: number
  mtime: Date
}

/** Collect this session's archived (downloadable) artifacts, newest-first.
 *  A row contributes ONLY when its persisted manifest validates AND the MP4
 *  exists — cleaned/deleted artifacts are skipped silently (the per-row
 *  download links already degrade honestly). Duplicate filenames (re-renders
 *  of the same clip) are de-duped with " (n)" suffixes so the zip never has
 *  two entries with the same name. */
async function collectArchiveEntries(ownerId: string): Promise<ArchiveEntry[]> {
  const rows = await db.renderJob.findMany({
    where: { ownerId, status: 'DONE' },
    orderBy: { createdAt: 'desc' },
    take: MAX_ARCHIVE_ENTRIES,
    select: { id: true, filename: true },
  })
  const rendersRoot = join(process.cwd(), 'upload', 'renders')
  const entries: ArchiveEntry[] = []
  const usedNames = new Set<string>()
  for (const row of rows) {
    if (!/^[\w-]{8,64}$/.test(row.id)) continue
    try {
      const manifestPath = join(rendersRoot, row.id, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      const m = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      const filename = typeof m.filename === 'string' ? m.filename : row.filename
      if (m?.id !== row.id || m.status !== 'done' || !filename || !SAFE_MP4_NAME.test(filename)) continue
      const mp4Path = join(rendersRoot, row.id, filename)
      const st = statSync(mp4Path)
      if (!st.isFile() || st.size <= 0) continue
      // dedupe entry names (same clip re-rendered → same output filename)
      let name = filename
      let n = 2
      while (usedNames.has(name)) {
        name = filename.replace(/\.mp4$/, ` (${n++}).mp4`)
      }
      usedNames.add(name)
      entries.push({ name, path: mp4Path, size: st.size, mtime: st.mtime })
    } catch {
      // unreadable manifest / vanished file — skip this row
    }
  }
  return entries
}

/** Build the streaming ZIP response. Pull-based ReadableStream (same memory
 *  posture as buildStreamingMultipart): one 8 MB read buffer at a time, file
 *  handles closed deterministically. Content-Length is exact (STORE entries
 *  have known sizes), so browsers can show a real progress bar. */
function buildArchiveZipStream(entries: ArchiveEntry[]): { stream: ReadableStream<Uint8Array>; totalBytes: number } {
  const enc = new TextEncoder()
  const CHUNK = STREAM_CHUNK

  // pre-compute sizes: per entry = local header (30 + nameLen) + data +
  // descriptor (16); central dir per entry = 46 + nameLen; EOCD = 22
  let offset = 0
  const central: { name: Uint8Array; crc: number; size: number; time: number; date: number; offset: number }[] = []
  const locals = entries.map((e) => {
    const nameBytes = enc.encode(e.name)
    const { time, date } = dosDateTime(e.mtime)
    const localOffset = offset
    offset += 30 + nameBytes.length + e.size + 16
    central.push({ name: nameBytes, crc: 0, size: e.size, time, date, offset: localOffset })
    return { entry: e, nameBytes, time, date }
  })
  const centralOffset = offset
  let cdSize = 0
  for (const c of central) cdSize += 46 + c.name.length
  const totalBytes = centralOffset + cdSize + 22

  let idx = 0
  let stage: 'head' | 'file' | 'desc' | 'central' | 'eocd' | 'done' = 'head'
  let fh: import('node:fs/promises').FileHandle | null = null
  let crc = 0
  const buf = Buffer.allocUnsafe(CHUNK)
  let position = 0
  let centralIdx = 0

  const release = async () => {
    const h = fh
    fh = null
    if (h) {
      try { await h.close() } catch { /* already closed */ }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (stage === 'head') {
          const cur = locals[idx]
          // reset per-entry accumulators BEFORE branching (zero-size entries
          // jump straight to the descriptor and must see crc=0, not the
          // previous entry's value)
          crc = 0
          position = 0
          const head = Buffer.alloc(30)
          head.writeUInt32LE(0x04034b50, 0) // local file header signature
          head.writeUInt16LE(20, 4) // version needed (2.0)
          head.writeUInt16LE(0x0808, 6) // flags: UTF-8 names + data descriptor
          head.writeUInt16LE(0, 8) // method: STORE
          head.writeUInt16LE(cur.time, 10)
          head.writeUInt16LE(cur.date, 12)
          // crc / csize / usize = 0 in the local header (descriptor carries them)
          head.writeUInt16LE(cur.nameBytes.length, 26)
          controller.enqueue(new Uint8Array(head))
          controller.enqueue(cur.nameBytes)
          stage = cur.entry.size === 0 ? 'desc' : 'file'
          return
        }
        if (stage === 'file') {
          const cur = locals[idx]
          if (!fh) fh = await open(cur.entry.path, 'r')
          const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, cur.entry.size - position), position)
          if (bytesRead <= 0 || position + bytesRead > cur.entry.size) {
            // file grew/shrank since stat — the central dir records the stated
            // size, so stop exactly there (best-effort honesty for a store)
            stage = 'desc'
            await release()
            return
          }
          const view = buf.subarray(0, bytesRead)
          crc = crc32Update(crc, view)
          position += bytesRead
          controller.enqueue(new Uint8Array(view)) // copy — buf is reused
          if (position >= cur.entry.size) {
            stage = 'desc'
            await release()
          }
          return
        }
        if (stage === 'desc') {
          const cur = locals[idx]
          central[idx].crc = crc
          const desc = Buffer.alloc(16)
          desc.writeUInt32LE(0x08074b50, 0) // data descriptor signature
          desc.writeUInt32LE(crc, 4)
          desc.writeUInt32LE(cur.entry.size, 8) // compressed (= stored) size
          desc.writeUInt32LE(cur.entry.size, 12) // uncompressed size
          controller.enqueue(new Uint8Array(desc))
          idx++
          if (idx >= locals.length) {
            stage = 'central'
            centralIdx = 0
          } else {
            stage = 'head'
          }
          return
        }
        if (stage === 'central') {
          if (centralIdx >= central.length) {
            stage = 'eocd'
            return
          }
          const c = central[centralIdx]
          const head = Buffer.alloc(46)
          head.writeUInt32LE(0x02014b50, 0) // central directory signature
          head.writeUInt16LE(20, 4) // version made by
          head.writeUInt16LE(20, 6) // version needed
          head.writeUInt16LE(0x0808, 8) // flags (matches local)
          head.writeUInt16LE(0, 10) // method: STORE
          head.writeUInt16LE(c.time, 12)
          head.writeUInt16LE(c.date, 14)
          head.writeUInt32LE(c.crc, 16)
          head.writeUInt32LE(c.size, 20) // csize
          head.writeUInt32LE(c.size, 24) // usize
          head.writeUInt16LE(c.name.length, 28)
          head.writeUInt32LE(c.offset, 42) // local header offset
          controller.enqueue(new Uint8Array(head))
          controller.enqueue(c.name)
          centralIdx++
          if (centralIdx >= central.length) stage = 'eocd'
          return
        }
        if (stage === 'eocd') {
          const eocd = Buffer.alloc(22)
          eocd.writeUInt32LE(0x06054b50, 0)
          eocd.writeUInt16LE(central.length, 8) // entries on this disk
          eocd.writeUInt16LE(central.length, 10) // total entries
          eocd.writeUInt32LE(cdSize, 12)
          eocd.writeUInt32LE(centralOffset, 16)
          controller.enqueue(new Uint8Array(eocd))
          stage = 'done'
          controller.close()
          return
        }
        // stage === 'done' — nothing more
      } catch (e) {
        await release()
        controller.error(e)
      }
    },
    async cancel() {
      await release()
    },
  })
  return { stream, totalBytes }
}

/** GET /api/render-proxy/archive — ZIP of every still-stored render this
 *  session owns. 404 when nothing is archivable (the UI hides the button in
 *  that case, but direct links must degrade honestly), 413 when the payload
 *  would exceed the 2 GB cap (tell the user to download/delete some first). */
async function buildOwnedArchive(): Promise<Response> {
  const ownerId = await getOrCreateSessionId()
  const entries = await collectArchiveEntries(ownerId)
  if (entries.length === 0) {
    return NextResponse.json(
      { error: 'No stored renders to download — finished MP4s appear here until they are cleaned.' },
      { status: 404 },
    )
  }
  const totalPayload = entries.reduce((s, e) => s + e.size, 0)
  if (totalPayload > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      {
        error: `Your stored renders total ${(totalPayload / 1024 / 1024 / 1024).toFixed(1)} GB — over the 2 GB archive cap. Download or delete some renders individually, then try again.`,
      },
      { status: 413 },
    )
  }
  const { stream, totalBytes } = buildArchiveZipStream(entries)
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const fname = `clipforge-renders-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.zip`
  return new NextResponse(stream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-length': String(totalBytes),
      'content-disposition': `attachment; filename="${fname}"`,
      'cache-control': 'no-store',
    },
  })
}

async function listOwnedRenderJobs(): Promise<Response> {
  const ownerId = await getOrCreateSessionId()
  // global housekeeping first (bounded, best-effort): heal abandoned-session
  // ACTIVE rows — this is also the mechanism that eventually resolves rows
  // like the observed "QUEUED forever after the owner's browser closed" —
  // and prune 7-day-old rows whose artifacts are gone (session cookie loss
  // makes them invisible to every future owner; disk is bounded by the
  // renderer GC, the DB rows were the last unbounded accumulator).
  await sweepStaleActiveRows()
  await pruneAncientRows()
  const rows = await db.renderJob.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  // reconcile only ACTIVE rows, bounded — never let history reads DoS the renderer.
  // Live artifact facts (size / duration / hasCover / dims) come from the
  // renderer's in-memory state or persisted manifest when it still knows the
  // job — they are NOT persisted (the RenderJob table is the AUTHORIZATION
  // record, by design; facts are merged into the response only while the
  // artifact survives on the renderer's disk).
  const active = rows.filter((r) => ACTIVE_STATUSES.has(r.status)).slice(0, 10)
  await Promise.all(active.map((row) => reconcileActiveRow(row)))

  // merge live artifact facts for DONE rows still known to the renderer —
  // bounded (top 10 done rows), timeout-guarded, fully optional
  const doneRows = rows.filter((r) => r.status === 'DONE').slice(0, 10)
  const facts = new Map<string, { size?: number; duration?: number; hasCover?: boolean; width?: number; height?: number; quality?: string; pinned?: boolean }>()
  await Promise.all(
    doneRows.map(async (row) => {
      try {
        const res = await fetch(`${RENDERER_BASE}/jobs/${row.id}`, {
          headers: rendererHeaders(),
          signal: AbortSignal.timeout(4000),
          cache: 'no-store',
        })
        if (res.ok) {
          const j = (await res.json()) as { size?: unknown; duration?: unknown; hasCover?: unknown; width?: unknown; height?: unknown; quality?: unknown; pinned?: unknown }
          facts.set(row.id, {
            ...(typeof j.size === 'number' && Number.isFinite(j.size) ? { size: Math.round(j.size) } : {}),
            ...(typeof j.duration === 'number' && Number.isFinite(j.duration) ? { duration: j.duration } : {}),
            hasCover: j.hasCover === true,
            ...(typeof j.width === 'number' && Number.isFinite(j.width) ? { width: j.width } : {}),
            ...(typeof j.height === 'number' && Number.isFinite(j.height) ? { height: j.height } : {}),
            ...(typeof j.quality === 'string' ? { quality: j.quality } : {}),
            pinned: j.pinned === true,
          })
        }
        // 404 = artifact past the renderer's retention window — the download
        // link will fail; facts stay absent (honest degradation)
      } catch {
        // unreachable — facts simply omitted
      }
    }),
  )

  // re-read after reconciliation so the response reflects the synced truth
  const finalRows = await db.renderJob.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      status: true,
      stage: true,
      filename: true,
      projectId: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  // attach availability flags + live facts (response-only, not persisted)
  const jobs = finalRows.map((r) => ({
    ...r,
    ...(facts.has(r.id) ? facts.get(r.id) : {}),
    downloadable: r.status === 'DONE' && facts.has(r.id),
  }))
  // queue depth (aggregate — relays the renderer's /stats so the UI can show
  // "1 rendering · N in line" honestly, incl. OTHER sessions' queued jobs)
  let queue: { waiting: number; busy: boolean } | null = null
  try {
    const res = await fetch(`${RENDERER_BASE}/stats`, {
      headers: rendererHeaders(),
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    })
    if (res.ok) {
      const s = (await res.json()) as { waiting?: unknown; busy?: unknown }
      if (typeof s.waiting === 'number' && Number.isFinite(s.waiting) && typeof s.busy === 'boolean') {
        queue = { waiting: Math.max(0, Math.trunc(s.waiting)), busy: s.busy }
      }
    }
  } catch {
    // stats are optional observability — the list still answers without them
  }
  return NextResponse.json(
    { jobs, queue },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * Wrap an incoming request stream with a hard byte cap so chunked uploads
 * (no Content-Length) cannot exceed the source limit mid-flight. Errors the
 * stream when the cap is exceeded — the upstream fetch aborts, the renderer's
 * formData() parse fails, and the caller sees 413 (never an OOM).
 * onCap fires synchronously at the moment the cap trips (for honest errors).
 */
function byteCappedStream(src: ReadableStream<Uint8Array>, maxBytes: number, onCap?: () => void): ReadableStream<Uint8Array> {
  let total = 0
  return src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        total += chunk.byteLength
        if (total > maxBytes) {
          onCap?.()
          ctrl.error(new Error('PAYLOAD_TOO_LARGE'))
          return
        }
        ctrl.enqueue(chunk)
      },
    }),
  )
}

/** Map a renderer status string to the canonical DB status (upper-snake). */
function canonicalStatus(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const map: Record<string, string> = {
    queued: 'QUEUED',
    extracting: 'EXTRACTING',
    rendering: 'RENDERING',
    finalizing: 'FINALIZING',
    done: 'DONE',
    error: 'ERROR',
    cancelled: 'CANCELLED',
  }
  return map[s] ?? null
}

/** Authorize a job operation: the row must exist AND belong to this session. */
async function authorizeJob(jobId: string): Promise<boolean> {
  if (!jobId || !/^[\w-]{8,64}$/.test(jobId)) return false
  const ownerId = await getOrCreateSessionId()
  const row = await db.renderJob.findUnique({ where: { id: jobId }, select: { ownerId: true } })
  return !!row && row.ownerId === ownerId
}

/** Opportunistically sync terminal/progress status into the DB row (cheap, only on change). */
async function syncJobStatus(
  jobId: string,
  upstreamStatus: unknown,
  upstreamStage: unknown,
  upstreamFilename?: unknown,
) {
  try {
    const status = canonicalStatus(upstreamStatus)
    if (!status) return
    const row = await db.renderJob.findUnique({ where: { id: jobId }, select: { status: true, stage: true, filename: true } })
    if (!row) return
    const stage = typeof upstreamStage === 'string' ? upstreamStage : null
    // renderer reports the finished MP4's filename — persist it once (used by
    // the render-history UI) without overwriting an existing value
    const filename = typeof upstreamFilename === 'string' && upstreamFilename ? upstreamFilename.slice(0, 255) : null
    const needsFile = filename && !row.filename
    if (row.status !== status || (stage && row.stage !== stage) || needsFile) {
      await db.renderJob.update({
        where: { id: jobId },
        data: {
          status,
          ...(stage ? { stage: stage.slice(0, 300) } : {}),
          ...(needsFile ? { filename } : {}),
        },
      })
    }
  } catch {
    // sync is best-effort observability — never break the poll
  }
}

/** Persist render-job ownership after a successful render start (security invariant).
 * Returns { ok, rendererJobId }: ok=false means the DB row is NOT guaranteed —
 * the caller MUST cancel the renderer job and fail honestly. A silently-swallowed
 * failure here used to strand a renderer job the client could never poll,
 * cancel, or download (every proxy operation 404s fail-closed). */
async function recordRenderJob(
  upstreamBody: string,
  projectId: string | null,
  fallbackStatus = 'QUEUED',
): Promise<{ ok: boolean; rendererJobId: string | null }> {
  let rendererJobId: string | null = null
  try {
    const parsed = JSON.parse(upstreamBody) as { id?: unknown; status?: unknown }
    if (typeof parsed?.id !== 'string' || !/^[\w-]{8,64}$/.test(parsed.id)) {
      return { ok: false, rendererJobId: null } // upstream contract broken — nothing to cancel by id
    }
    rendererJobId = parsed.id
    const ownerId = await getOrCreateSessionId()
    await db.renderJob.upsert({
      where: { id: parsed.id },
      create: {
        id: parsed.id,
        ownerId,
        projectId,
        status: canonicalStatus(parsed.status) ?? fallbackStatus,
        stage: 'Queued',
      },
      update: { ownerId, projectId },
    })
    return { ok: true, rendererJobId }
  } catch {
    // DB/session failure — report to the caller so the renderer job is cancelled
    // and the client gets an honest 5xx (never a doomed job id).
    return { ok: false, rendererJobId }
  }
}

/**
 * Build a multipart/form-data body as a CONSUMER-DRIVEN stream (pull-based):
 * file reads happen only when the downstream fetch pulls — memory stays bounded
 * at ~2 chunks regardless of source size (the old start()-pump enqueued the
 * ENTIRE file into the stream's internal queue as fast as disk allowed, which
 * re-materialized a 1.5 GB source chunk-by-chunk in RAM).
 * Returns the stream AND the boundary (needed for the Content-Type header).
 */
function buildStreamingMultipart(
  absolutePath: string,
  fileMime: string,
  fileName: string,
  recipeJson: string,
): { stream: ReadableStream<Uint8Array>; boundary: string } {
  const boundary = `----clipforge${randomUUID().replace(/-/g, '')}`
  const pre = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${fileName.replace(/["\r\n]/g, '_')}"\r\nContent-Type: ${fileMime}\r\n\r\n`,
  )
  const post = new TextEncoder().encode(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="recipe"\r\n\r\n${recipeJson}\r\n--${boundary}--\r\n`,
  )
  const CHUNK = STREAM_CHUNK
  let stage: 'pre' | 'file' | 'post' | 'done' = 'pre'
  let fh: import('node:fs/promises').FileHandle | null = null
  const buf = Buffer.allocUnsafe(CHUNK)
  let position = 0
  const release = async () => {
    const h = fh
    fh = null
    if (h) {
      try { await h.close() } catch { /* already closed */ }
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (stage === 'pre') {
          controller.enqueue(pre)
          stage = 'file'
          return
        }
        if (stage === 'file') {
          if (!fh) fh = await open(absolutePath, 'r')
          const { bytesRead } = await fh.read(buf, 0, CHUNK, position)
          if (bytesRead <= 0) {
            stage = 'post'
            return // pull is called again immediately → 'post' branch below
          }
          controller.enqueue(new Uint8Array(buf.subarray(0, bytesRead))) // copy — buf is reused
          position += bytesRead
          return
        }
        if (stage === 'post') {
          controller.enqueue(post)
          stage = 'done'
          controller.close()
          await release()
          return
        }
        // stage === 'done' — stream closed; nothing further to produce
      } catch (e) {
        await release()
        controller.error(e)
      }
    },
    async cancel() {
      // downstream aborted mid-upload (renderer 4xx, cap trip, client cancel):
      // release the file handle — the read loop never runs again.
      await release()
    },
  })
  return { stream, boundary }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
  const targetPath = '/' + path.join('/')

  // fail closed when the internal auth is not configured — the renderer would
  // 401 every request anyway; a clear 500 beats a confusing relayed 401
  if (!RENDERER_TOKEN) {
    return NextResponse.json(
      { error: 'Renderer authentication is not configured (CLIPFORGE_RENDERER_TOKEN missing on the server)' },
      { status: 500 },
    )
  }

  // ---- POST /jobs/:id/pin — pin/unpin a DONE artifact (GC exemption) ----
  // Handled BEFORE ensureRenderer: flipping a manifest flag must not revive a
  // dead renderer (same economy as DELETE). Ownership gate → renderer relay
  // (authoritative — validates + updates the in-memory echo) → direct-FS
  // manifest edit when the renderer is down (the manifest on disk IS the
  // durable source of truth; a revived renderer reads it back).
  const pinMatch = targetPath.match(/^\/jobs\/([\w-]{8,64})\/pin$/)
  if (pinMatch) {
    const jobId = pinMatch[1]
    const ok = await authorizeJob(jobId)
    if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    // active rows refuse — matches the renderer's own semantics
    const row = await db.renderJob.findUnique({ where: { id: jobId }, select: { status: true } })
    if (row && ACTIVE_STATUSES.has(row.status)) {
      return NextResponse.json(
        { error: 'This render is still running — wait for it to finish before pinning.' },
        { status: 409 },
      )
    }
    let pinned = false
    try {
      const raw = await req.text()
      if (raw.length > 256) return NextResponse.json({ error: 'Pin body too large' }, { status: 400 })
      pinned = (JSON.parse(raw) as { pinned?: unknown }).pinned === true
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body — expected { "pinned": boolean }' }, { status: 400 })
    }
    // renderer-first (no revive; 4s timeout)
    try {
      const res = await fetch(`${RENDERER_BASE}/jobs/${jobId}/pin`, {
        method: 'POST',
        headers: rendererHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ pinned }),
        signal: AbortSignal.timeout(4000),
      })
      if (res.status === 409) {
        const b = await res.text()
        return new NextResponse(b, { status: 409, headers: { 'content-type': 'application/json' } })
      }
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { pinned?: boolean }
        return NextResponse.json({ id: jobId, pinned: data.pinned ?? pinned }, { headers: { 'cache-control': 'no-store' } })
      }
      if (res.status === 404) {
        return NextResponse.json(
          { error: 'No stored artifact to pin — it may have been cleaned or deleted.' },
          { status: 404 },
        )
      }
      return NextResponse.json({ error: 'Pin failed at the render service.' }, { status: 502 })
    } catch {
      // renderer unreachable → direct-FS manifest edit (same repo layout)
      const rendersRoot = join(process.cwd(), 'upload', 'renders')
      const manifestPath = join(rendersRoot, jobId, 'manifest.json')
      try {
        if (!existsSync(manifestPath) || !manifestPath.startsWith(rendersRoot)) {
          return NextResponse.json(
            { error: 'No stored artifact to pin — it may have been cleaned or deleted.' },
            { status: 404 },
          )
        }
        const m = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
        if (m?.id !== jobId || m.status !== 'done' || typeof m.filename !== 'string' || !SAFE_MP4_NAME.test(m.filename)) {
          return NextResponse.json({ error: 'Stored manifest failed validation.' }, { status: 500 })
        }
        m.pinned = pinned
        await writeFile(manifestPath, JSON.stringify(m))
        return NextResponse.json({ id: jobId, pinned }, { headers: { 'cache-control': 'no-store' } })
      } catch {
        return NextResponse.json(
          { error: 'Could not update the pin — the render service is unreachable and the manifest could not be edited.' },
          { status: 502 },
        )
      }
    }
  }

  // SELF-HEALING: if the renderer mini-service is down (sandbox process
  // reaping, crash, reboot), bring it back before proxying — render requests
  // must never fail with a bare 502 when a start is possible.
  if (!(await ensureRenderer())) {
    return NextResponse.json(
      { error: 'Renderer service unavailable and could not be started. Try again shortly.' },
      { status: 503, headers: { 'Retry-After': '10' } },
    )
  }

  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const contentType = req.headers.get('content-type') ?? ''

  // render starts are expensive → rate limit; job cancels are cheap but still authorized
  const isRenderStart = targetPath === '/render'
  if (isRenderStart) {
    const rl = checkRateLimit(`render:${ip}`, 6, 60_000)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded — too many renders. Please wait a minute.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      )
    }
  }

  // ---- ownership gate for job operations (cancel) ----
  const jobMatch = targetPath.match(JOB_PATH_RE)
  if (jobMatch) {
    const ok = await authorizeJob(jobMatch[1])
    if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const targetUrl = RENDERER_BASE + targetPath + (url.search || '')

  let body: BodyInit
  const headers: Record<string, string> = {}
  let rawBody: string | null = null
  let recipeJson: string | null = null
  let projectIdForRecord: string | null = null
  let payloadTooLarge = false // set when the byte cap trips mid-stream

  if (contentType.includes('application/json') && targetPath === '/render') {
    // ---- JSON mode: project-source render (server-side media) ----
    rawBody = await req.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_RECIPE_BYTES + 4096) {
      return NextResponse.json({ error: 'Request body too large', code: 'RECIPE_TOO_LARGE' }, { status: 413 })
    }
    let parsed: { recipe?: unknown; projectId?: unknown } = {}
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    projectIdForRecord = typeof parsed.projectId === 'string' ? parsed.projectId : null
    recipeJson = typeof parsed.recipe === 'string' ? parsed.recipe : null
    if (!projectIdForRecord || !recipeJson) {
      return NextResponse.json({ error: 'projectId and recipe are required' }, { status: 400 })
    }
    if (Buffer.byteLength(recipeJson, 'utf8') > MAX_RECIPE_BYTES) {
      return NextResponse.json({ error: 'Recipe JSON exceeds the 1 MB limit', code: 'RECIPE_TOO_LARGE' }, { status: 413 })
    }
    const ownerId = await getOrCreateSessionId()

    // ---------- daily soft limit (persisted usage, friendly 429) ----------
    const daily = await checkDailyUsageLimit(ownerId, 'render')
    if (!daily.allowed) {
      return NextResponse.json(
        { error: limitReachedMessage({ ...daily, kind: 'render' }), code: 'DAILY_LIMIT_REACHED', kind: 'render', used: daily.used, cap: daily.cap, resetAt: daily.resetAt },
        { status: 429, headers: limitHeaders(daily) },
      )
    }

    const project = await db.project.findFirst({
      where: { id: projectIdForRecord, ownerId },
      select: { localMedia: true, localMediaState: true, localMediaSize: true, title: true, youtubeId: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    // rendering from the cached source is an LRU touch (throttled, best-effort)
    if (project.youtubeId && project.localMedia?.startsWith('upload/yt/')) {
      touchMediaCache(project.youtubeId)
    }
    if (project.localMediaState !== 'ready' || !project.localMedia) {
      return NextResponse.json(
        { error: 'This project has no downloadable source media (state: ' + (project.localMediaState ?? 'unavailable') + '). Upload the video file instead.' },
        { status: 409 },
      )
    }
    const absolute = resolveLocalMediaPath(project.localMedia)
    if (!absolute) {
      return NextResponse.json({ error: 'Stored media path failed validation' }, { status: 500 })
    }
    let sizeBytes = 0
    try {
      sizeBytes = statSync(absolute).size
    } catch {
      return NextResponse.json(
        { error: 'Stored source media is missing on disk — re-run source prepare or upload the file.' },
        { status: 410 },
      )
    }
    if (sizeBytes > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Stored source media exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    // STREAM the stored media into a multipart body — no whole-file RAM buffer.
    const mime = mediaMimeForExt(absolute.split('.').pop() ?? '') ?? 'video/mp4'
    const mp = buildStreamingMultipart(absolute, mime, basename(absolute), recipeJson)
    body = mp.stream
    headers['content-type'] = `multipart/form-data; boundary=${mp.boundary}`

    // ---- usage metering: a render START is the billable action (best-effort) ----
    try {
      let renderSeconds: number | undefined
      try {
        const r = JSON.parse(recipeJson) as { output_duration?: number }
        renderSeconds = isFinite(Number(r?.output_duration)) ? Number(r.output_duration) : undefined
      } catch { /* quantity=1 still recorded */ }
      void recordUsage(ownerId, 'render', 1, { renderSeconds, projectId: projectIdForRecord })
    } catch { /* never block rendering */ }
  } else if (contentType.includes('multipart/form-data')) {
    // resource guard: reject declared oversize uploads BEFORE streaming starts
    const declaredLen = Number(req.headers.get('content-length') ?? '')
    if (isFinite(declaredLen) && declaredLen > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Upload exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    // MEMORY SAFETY: forward the multipart body AS A STREAM (byte-capped).
    // The old `await req.blob()` materialized the entire upload (up to 1.5 GB)
    // in server RAM before a single byte reached the renderer.
    if (!req.body) {
      return NextResponse.json({ error: 'Empty multipart body' }, { status: 400 })
    }
    body = byteCappedStream(req.body, MAX_SOURCE_BYTES, () => { payloadTooLarge = true })
    headers['content-type'] = contentType // preserves the multipart boundary
  } else {
    rawBody = await req.text()
    body = rawBody
    headers['content-type'] = contentType || 'application/json'
  }

  // usage metering + daily soft limit for the multipart passthrough path (recipe not parsed here)
  if (isRenderStart && !recipeJson) {
    try {
      const ownerId = await getOrCreateSessionId()
      const daily = await checkDailyUsageLimit(ownerId, 'render')
      if (!daily.allowed) {
        return NextResponse.json(
          { error: limitReachedMessage({ ...daily, kind: 'render' }), code: 'DAILY_LIMIT_REACHED', kind: 'render', used: daily.used, cap: daily.cap, resetAt: daily.resetAt },
          { status: 429, headers: limitHeaders(daily) },
        )
      }
      void recordUsage(ownerId, 'render', 1, {})
    } catch { /* never block rendering */ }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: rendererHeaders(headers),
      body,
      // propagate client disconnects as a CONTROLLED abort — without this,
      // a mid-upload disconnect surfaces later as an undici socket error
      // (unhandledRejection: TypeError: terminated)
      signal: req.signal,
      // @ts-expect-error — undici duplex option for stream bodies
      duplex: 'half',
    })
    const respBody = await upstream.arrayBuffer()
    // record ownership for the NEW job (both render modes) — required for all
    // subsequent poll/stream/cancel/download authorization. A recording failure
    // must NOT be silent: cancel the renderer job (no orphan work) and fail
    // honestly — the client must never receive an id that every later operation
    // would 404.
    if (upstream.ok) {
      const recorded = await recordRenderJob(Buffer.from(respBody).toString('utf8'), projectIdForRecord)
      if (!recorded.ok) {
        if (recorded.rendererJobId) {
          try {
            // authenticated with the SAME internal token — an unauthenticated
            // cancel would be rejected 401 and strand the orphan job
            await fetch(`${RENDERER_BASE}/jobs/${recorded.rendererJobId}/cancel`, {
              method: 'POST',
              headers: rendererHeaders(),
            })
          } catch { /* renderer unavailable — job self-expires with its artifacts */ }
        }
        return NextResponse.json(
          { error: 'Render started but job ownership could not be recorded; the render was cancelled. Please retry.' },
          { status: 500 },
        )
      }
    }
    return new NextResponse(respBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (e: any) {
    // the byte cap aborts the stream mid-flight → surface an honest 413
    if (payloadTooLarge || e?.message === 'PAYLOAD_TOO_LARGE') {
      return NextResponse.json({ error: 'Upload exceeds the 1.5 GB render cap' }, { status: 413 })
    }
    return NextResponse.json({ error: e?.message ?? 'proxy failed' }, { status: 502 })
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
  const targetPath = '/' + path.join('/')

  // fail closed when the internal auth is not configured (see POST)
  if (!RENDERER_TOKEN) {
    return NextResponse.json(
      { error: 'Renderer authentication is not configured (CLIPFORGE_RENDERER_TOKEN missing on the server)' },
      { status: 500 },
    )
  }

  // ---- GET /archive — bulk ZIP download of owned finished renders ----
  // Handled BEFORE ensureRenderer on purpose: the archive is built straight
  // from the persisted store on disk; a bulk download must never revive (or
  // wait on) the renderer service. Ownership = the RenderJob table.
  if (targetPath === '/archive') {
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
    const rl = checkRateLimit(`archive:${ip}`, 4, 60_000)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many archive downloads — please wait a minute.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      )
    }
    return buildOwnedArchive()
  }

  // SELF-HEALING: polls/streams/downloads of a known job also revive a dead
  // renderer (job state is in-memory — a restart loses it, but the ownership
  // DB row stays; the honest outcome is a renderer 404, not a proxy 502).
  if (!(await ensureRenderer())) {
    return NextResponse.json(
      { error: 'Renderer service unavailable and could not be started. Try again shortly.' },
      { status: 503, headers: { 'Retry-After': '10' } },
    )
  }

  // GET /api/render-proxy/jobs — owned render history (reconciled). Handled
  // BEFORE the per-job gate because '/jobs' (bare) does not match JOB_PATH_RE.
  if (targetPath === '/jobs') {
    return listOwnedRenderJobs()
  }

  // ---- ownership gate: poll / stream / download are ALL owner-scoped ----
  const jobMatch = targetPath.match(JOB_PATH_RE)
  if (jobMatch) {
    const ok = await authorizeJob(jobMatch[1])
    if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const targetUrl = RENDERER_BASE + targetPath + (url.search || '')

  // MEMORY SAFETY: download/cover are LARGE binary artifacts (full MP4s) —
  // pipe the upstream body straight through, never await arrayBuffer().
  // Poll (GET /jobs/:id) stays buffered: it is a tiny JSON document the proxy
  // also inspects for DB status sync.
  const binaryArtifact = jobMatch?.[3] === 'download' || jobMatch?.[3] === 'cover'

  try {
    // signal: client disconnect (closed EventSource / aborted download) must
    // abort the upstream fetch deterministically — otherwise the runtime's
    // cancellation of the passthrough body races undici's socket handling and
    // surfaces as an unhandled socket-error rejection.
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: rendererHeaders(),
      signal: req.signal,
    })
    const ct = upstream.headers.get('content-type') ?? 'application/octet-stream'
    if (ct.includes('text/event-stream')) {
      // SSE: forward the upstream body DIRECTLY (byte-identical event format).
      // The old manual reader/pump wrapper never cancelled the upstream when the
      // browser disconnected (leaking the renderer connection + its subscriber),
      // and a read error inside the detached pump was an unhandled rejection that
      // left the downstream hanging. Native body passthrough propagates
      // backpressure, upstream errors, and downstream cancellation for free.
      if (!upstream.body) return new NextResponse(null, { status: 502 })
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        },
      })
    }
    if (binaryArtifact) {
      // STREAM THROUGH with the renderer's own headers preserved (content-type,
      // content-length, content-disposition, cache-control). The 404/410 error
      // bodies from the renderer are JSON — those stay buffered via the same
      // branch (status !== ok and tiny), but the header passthrough is harmless.
      const passthrough: Record<string, string> = { 'content-type': ct }
      for (const h of ['content-length', 'content-disposition', 'cache-control']) {
        const v = upstream.headers.get(h)
        if (v) passthrough[h] = v
      }
      if (!upstream.ok || !upstream.body) {
        // renderer error (404 not ready / 410 expired): relay the small JSON body
        const errBody = await upstream.text()
        return new NextResponse(errBody, { status: upstream.status, headers: { 'content-type': ct } })
      }
      return new NextResponse(upstream.body, { status: upstream.status, headers: passthrough })
    }
    const respBody = await upstream.arrayBuffer()
    // opportunistic DB status sync (observability) on plain job polls
    if (jobMatch && !jobMatch[3] && upstream.ok) {
      try {
        const j = JSON.parse(Buffer.from(respBody).toString('utf8')) as { status?: unknown; stage?: unknown; filename?: unknown }
        void syncJobStatus(jobMatch[1], j.status, j.stage, j.filename)
      } catch { /* best-effort */ }
    }
    // HONEST STALE-ROW RECONCILIATION: the renderer returned 404 for a job the
    // DB still considers ACTIVE. That happens when the renderer restarted
    // (supervisor respawn) — its job state is in-memory and gone. Instead of
    // relaying a bare 404 that the client would read as "expired", mark the
    // owned row ERROR with an honest, actionable message. The user sees
    // "render lost, re-render" instead of a poll that never terminates.
    if (jobMatch && !jobMatch[3] && upstream.status === 404) {
      try {
        const row = await db.renderJob.findUnique({ where: { id: jobMatch[1] }, select: { status: true } })
        if (row && ACTIVE_STATUSES.has(row.status)) {
          await db.renderJob.update({
            where: { id: jobMatch[1] },
            data: {
              status: 'ERROR',
              stage: 'Render job lost — the render service restarted. Please render again.',
            },
          })
        }
      } catch { /* reconciliation is best-effort; the 404 still relays */ }
    }
    return new NextResponse(respBody, {
      status: upstream.status,
      headers: { 'content-type': ct },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'proxy failed' }, { status: 502 })
  }
}

/**
 * DELETE /api/render-proxy/jobs/:id — delete a render + its stored artifacts.
 *
 * User agency over the persisted store (the worklog's "delete affordance"):
 *   1. ownership gate (the row must exist AND belong to this session)
 *   2. ACTIVE rows refuse with 409 — cancel the render first
 *   3. ask the renderer to drop everything it holds for the job (persisted
 *      artifact dir + legacy jobDir + in-memory registry entry + spool)
 *   4. renderer unreachable (NOT revived for a delete — wasteful) → direct
 *      filesystem removal of upload/renders/<jobId> (same repo layout; the
 *      job id is strictly [\w-]{8,64} so path traversal is impossible)
 *   5. delete the authorization/history row itself — idempotent
 * The renderer's DELETE is idempotent (200 { removed:false } for already-gone
 * artifacts), so the DB row is removed whenever the gate passes.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
  const targetPath = '/' + path.join('/')

  // only bare /jobs/:id (no sub-action)
  const jobMatch = targetPath.match(/^\/jobs\/([\w-]{8,64})$/)
  if (!jobMatch) {
    return NextResponse.json({ error: 'Unsupported delete path' }, { status: 404 })
  }
  const jobId = jobMatch[1]

  // ---- ownership gate (same as every other job operation) ----
  const ok = await authorizeJob(jobId)
  if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // ---- active rows must be cancelled first ----
  const row = await db.renderJob.findUnique({ where: { id: jobId }, select: { status: true } })
  if (row && ACTIVE_STATUSES.has(row.status)) {
    return NextResponse.json(
      { error: 'This render is still running — cancel it first, then delete.' },
      { status: 409 },
    )
  }

  // ---- renderer-side removal (artifacts + registry) ----
  let rendererRemoved = false
  try {
    const res = await fetch(`${RENDERER_BASE}/jobs/${jobId}`, {
      method: 'DELETE',
      headers: rendererHeaders(),
      signal: AbortSignal.timeout(4000),
    })
    if (res.status === 409) {
      // renderer still considers the job active (reconcile lag) — relay honestly
      const body = await res.text()
      return new NextResponse(body, { status: 409, headers: { 'content-type': 'application/json' } })
    }
    rendererRemoved = res.ok
  } catch {
    // renderer down — fall through to direct FS removal (no ensureRenderer:
    // reviving a whole service just to unlink a directory is wasteful)
  }
  if (!rendererRemoved) {
    try {
      const persistDir = join(process.cwd(), 'upload', 'renders', jobId)
      // defense-in-depth: never follow a path that escaped the renders root
      if (existsSync(persistDir) && persistDir.startsWith(join(process.cwd(), 'upload', 'renders'))) {
        rmSync(persistDir, { recursive: true, force: true })
      }
    } catch {
      // best-effort — the renderer's GC covers leftovers on later sweeps
    }
  }

  // ---- remove the authorization/history row (idempotent) ----
  try {
    await db.renderJob.delete({ where: { id: jobId } })
  } catch {
    // already deleted — idempotent success
  }
  return NextResponse.json({ deleted: true, id: jobId }, { headers: { 'cache-control': 'no-store' } })
}

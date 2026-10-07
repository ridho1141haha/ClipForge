import { NextRequest, NextResponse } from 'next/server'
import { createReadStream, statSync } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { db } from '@/lib/db'
import { getOrCreateSessionId } from '@/lib/session'
import { mediaMimeForExt, resolveLocalMediaPath } from '@/lib/media'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/media/[projectId] — stream the owning session's project source media.
 *
 * Status: VERIFIED backend endpoint (owner-scoped, path-contained, Range/206).
 * NOT yet wired into a UI player — the Auto-Edit preview still uses the
 * YouTube iframe. Wiring an HTML5 keep-range preview player to this endpoint
 * is a planned next step; the contract below is final:
 *
 * Security / honesty rules:
 *  - owner-scoped: a foreign session gets 404 (id existence is never disclosed)
 *  - the client never sends a path; the path comes from the DB and is
 *    re-validated with resolveLocalMediaPath (upload/-prefix + traversal guard)
 *  - only projects with localMediaState='ready' are streamable
 *  - HTTP Range requests are honored (206) so <video> can seek instantly
 *    without downloading the whole file.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await getOrCreateSessionId()
    // NOTE: the dynamic segment is named [projectId] — the params key MUST be
    // `projectId`. Destructuring any other name yields `undefined`, and Prisma
    // silently drops `undefined` filters, which would stream the FIRST owned
    // project's media regardless of the requested id.
    const { projectId: id } = await ctx.params
    if (!id) {
      return NextResponse.json({ error: 'Project id is required' }, { status: 400 })
    }
    const project = await db.project.findFirst({
      where: { id, ownerId },
      select: { localMedia: true, localMediaState: true, localMediaSize: true, title: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (project.localMediaState !== 'ready' || !project.localMedia) {
      return NextResponse.json(
        { error: 'No streamable source media for this project (state: ' + (project.localMediaState ?? 'unavailable') + ')' },
        { status: 409 },
      )
    }
    const absolute = resolveLocalMediaPath(project.localMedia)
    if (!absolute) {
      return NextResponse.json({ error: 'Stored media path failed validation' }, { status: 500 })
    }
    let size = 0
    try {
      size = statSync(absolute).size
    } catch {
      return NextResponse.json(
        { error: 'Source media missing on disk — re-run source prepare or upload the file.' },
        { status: 410 },
      )
    }

    const mime = mediaMimeForExt(absolute.split('.').pop() ?? '') ?? 'video/mp4'
    const filename = absolute.split('/').pop() ?? 'source.mp4'

    // ---- Range handling (essential for <video> seeking) ----
    const rangeHeader = req.headers.get('range')
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (m && (m[1] !== '' || m[2] !== '')) {
        let start: number
        let end: number
        if (m[1] === '') {
          // suffix range: last N bytes
          const n = Math.min(parseInt(m[2], 10), size)
          start = size - n
          end = size - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1)
        }
        if (!isFinite(start) || !isFinite(end) || start > end || start >= size) {
          return new NextResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          })
        }
        const stream = createReadStream(absolute, { start, end })
        return streamToResponse(stream, 206, {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=0, must-revalidate',
          'Content-Disposition': `inline; filename="${filename}"`,
        })
      }
    }

    // Full response — still stream (no whole-file buffering)
    const stream = createReadStream(absolute)
    return streamToResponse(stream, 200, {
      'Content-Type': mime,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Content-Disposition': `inline; filename="${filename}"`,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Convert a node ReadStream into a web Response body with headers. */
function streamToResponse(stream: ReadStream, status: number, headers: Record<string, string>) {
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      stream.on('end', () => controller.close())
      stream.on('error', (err) => controller.error(err))
    },
    cancel() {
      stream.destroy()
    },
  })
  return new NextResponse(webStream, { status, headers })
}

import { NextResponse } from 'next/server'
import { statSync, existsSync } from 'node:fs'
import { resolveLocalMediaPath } from '@/lib/media'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** TEMPORARY debug route — delete after diagnosing media-410 false positive. */
export async function GET() {
  const rel = 'upload/yt/dQw4w9WgXcQ/source.mp4'
  const resolved = resolveLocalMediaPath(rel)
  let stat: string
  try {
    stat = String(statSync(resolved!).size)
  } catch (e) {
    stat = 'STAT FAILED: ' + (e as Error).message + ' code=' + (e as { code?: string }).code
  }
  return NextResponse.json({
    cwd: process.cwd(),
    exists: existsSync('/home/z/my-project/upload/yt/dQw4w9WgXcQ/source.mp4'),
    resolved,
    stat,
    envUpload: process.env.CLIPFORGE_UPLOAD_ROOT ?? null,
  })
}

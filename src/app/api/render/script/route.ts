import { NextRequest, NextResponse } from 'next/server'
import { generateFFmpegScript, generateASS, buildRecipeJSON, buildRenderRecipe, type RenderRecipe } from '@/lib/render-recipe'
import { checkRateLimit } from '@/lib/validation'

interface Body {
  plan: any
  youtubeId: string
  format: 'sh' | 'ass' | 'json'
}

export async function POST(req: NextRequest) {
  // rate limit (Phase 11) — script generation is CPU-bound
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const rl = checkRateLimit(`render-script:${ip}`, 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } })
  }
  try {
    const body = (await req.json()) as Body
    if (!body.plan || !body.youtubeId) {
      return NextResponse.json({ error: 'plan and youtubeId are required' }, { status: 400 })
    }
    const recipe = buildRenderRecipe(body.plan, body.youtubeId)
    if (!recipe.clipId || recipe.duration <= 0) {
      return NextResponse.json({ error: 'Invalid edit plan' }, { status: 400 })
    }

    const format = body.format ?? 'sh'

    if (format === 'ass') {
      const content = generateASS(recipe)
      return new NextResponse(content, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="clipforge_${sanitize(recipe.title)}.ass"`,
        },
      })
    }

    if (format === 'json') {
      const content = buildRecipeJSON(recipe)
      return new NextResponse(content, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="clipforge_${sanitize(recipe.title)}_recipe.json"`,
        },
      })
    }

    // default: sh
    const youtubeUrl = body.youtubeId ? `https://www.youtube.com/watch?v=${body.youtubeId}` : undefined
    const content = generateFFmpegScript(recipe, { youtubeUrl })
    const safeTitle = sanitize(recipe.title)
    return new NextResponse(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Content-Disposition': `attachment; filename="clipforge_${safeTitle}.sh"`,
      },
    })
  } catch (e: any) {
    console.error('Render script error:', e)
    return NextResponse.json({ error: e?.message ?? 'Failed' }, { status: 500 })
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)
}

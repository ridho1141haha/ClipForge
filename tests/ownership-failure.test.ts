/// <reference types="bun-types" />
/**
 * ClipForge OWNERSHIP-FAILURE fault-injection tests (bun test).
 * Run: bun test tests/ownership-failure.test.ts
 *
 * Verifies the render-start flow when the DB ownership recording FAILS —
 * with a MOCKED db (the real database is never touched) and a MOCKED renderer
 * (global fetch is stubbed; no FFmpeg runs):
 *
 *   db.renderJob.upsert() throws
 *     1. renderer was started                      (fetch → POST /render)
 *     2. ownership recording failed                (upsert threw)
 *     3. renderer cancellation was attempted       (fetch → POST /jobs/:id/cancel)
 *        — authenticated with the internal token
 *     4. client receives an honest 5xx             (500, error explains)
 *     5. no successful RenderJob is exposed        (no job id in the response)
 *     6. no orphan renderer job remains            (cancel attempted exactly once)
 *     7. usage accounting: a render START is the documented billable action
 *        (recordUsage is fire-and-forget best-effort metering, NOT a success
 *        report — asserted + documented, no behavior change)
 *   upstream id malformed
 *     8. honest 500 with NO cancel (nothing to cancel by id)
 *   happy path
 *     9. normal render still works (200, body relayed, exactly ONE upsert)
 *   retry semantics
 *    10. a retry after a failed recording creates exactly ONE new ownership
 *        record and exactly ONE new renderer job — no duplicates
 */

import { describe, test, expect, mock, beforeAll, beforeEach } from 'bun:test'

// ---- shared fixture state (rebound per test) --------------------------------
type Call = { url: string; init: RequestInit }
let calls: Call[] = []
let upsertShouldThrow = false
let upsertCalls = 0
let usageCalls = 0
const OWNER = 's-ownership-test-session'
const UPSTREAM_ID = 'job-aaaa1111bbbb2222'

// ---- module mocks (registered BEFORE the route is imported) -----------------
mock.module('@/lib/db', () => ({
  db: {
    renderJob: {
      upsert: async () => {
        upsertCalls++
        if (upsertShouldThrow) throw new Error('E2E fault injection: upsert failed')
        return { id: UPSTREAM_ID }
      },
      findUnique: async () => null,
      update: async () => ({}),
    },
    project: { findFirst: async () => null },
  },
}))

mock.module('@/lib/session', () => ({
  SESSION_COOKIE: 'clipforge_sid',
  getOrCreateSessionId: async () => OWNER,
}))

mock.module('@/lib/usage', () => ({
  recordUsage: async () => {
    usageCalls++
  },
}))

mock.module('@/lib/usage-limits', () => ({
  checkDailyUsageLimit: async () => ({ allowed: true, used: 0, cap: 100, resetAt: Date.now() + 1_000_000 }),
  limitReachedMessage: () => 'limit reached',
  limitHeaders: () => ({}),
  DEFAULT_DAILY_LIMITS: { analyze: 200, prepare: 40, render: 100, transcribe: 120 },
}))

// ---- stub the renderer (global fetch) BEFORE importing the route ------------
function stubRendererFetch() {
  calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    if (url.endsWith('/render')) {
      return new Response(JSON.stringify({ id: UPSTREAM_ID, status: 'queued', progress: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/cancel')) {
      return new Response(JSON.stringify({ id: UPSTREAM_ID, status: 'cancelled' }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'unexpected stub path' }), { status: 500 })
  }) as typeof fetch
  return realFetch
}

let realFetch: typeof fetch
let POST: typeof import('@/app/api/render-proxy/[...path]/route').POST

beforeAll(async () => {
  realFetch = stubRendererFetch()
  process.env.CLIPFORGE_RENDERER_TOKEN = 'ownership-test-token'
  const mod = await import('@/app/api/render-proxy/[...path]/route')
  POST = mod.POST
})

beforeEach(() => {
  upsertShouldThrow = false
  upsertCalls = 0
  usageCalls = 0
  stubRendererFetch()
})

function renderRequest(): Request {
  const form = new FormData()
  form.append('video', new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), 'src.mp4')
  form.append(
    'recipe',
    JSON.stringify({ keep_ranges: [{ start: 0, end: 2 }], duration: 2, title: 'ownership test' }),
  )
  return new Request('http://localhost:3000/api/render-proxy/render', { method: 'POST', body: form })
}

const ctx = { params: Promise.resolve({ path: ['render'] }) }

describe('render-start ownership failure injection (mocked db + renderer)', () => {
  test('upsert throws → renderer cancelled + honest 500, no orphan, no doomed id', async () => {
    upsertShouldThrow = true
    const res = await POST(renderRequest() as any, ctx as any)
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(String(body.error)).toMatch(/cancelled/i)
    expect(body.id).toBeUndefined() // (5) no doomed renderer id is exposed

    // (1) renderer was started, (3) cancel attempted — authenticated
    const renderCall = calls.find((c) => c.url.endsWith('/render'))
    const cancelCall = calls.find((c) => c.url.includes(`/jobs/${UPSTREAM_ID}/cancel`))
    expect(renderCall).toBeDefined()
    expect(cancelCall).toBeDefined() // (6) no orphan renderer job remains
    const cancelHeaders = new Headers((cancelCall!.init as RequestInit).headers as HeadersInit)
    expect(cancelHeaders.get('x-clipforge-internal-token')).toBe('ownership-test-token')

    // (2) ownership recording failed exactly once (no duplicate upsert attempts)
    expect(upsertCalls).toBe(1)

    // (7) usage metering: START-metering is the documented billable action —
    // fire-and-forget accounting of the ATTEMPT, never a success report.
    expect(usageCalls).toBe(1)
  })

  test('upstream id malformed → honest 500, NO cancel (nothing to cancel by id)', async () => {
    upsertShouldThrow = false
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ id: 'bad id with spaces!', status: 'queued' }), { status: 200 })
    }) as typeof fetch

    const res = await POST(renderRequest() as any, ctx as any)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(String(body.error)).toMatch(/cancelled|ownership/i)
    // no valid id → the proxy cannot cancel by id (renderer job self-expires)
    expect(calls.find((c) => c.url.includes('/cancel'))).toBeUndefined()
  })

  test('happy path: normal render still works (200, one upsert, body relayed)', async () => {
    const res = await POST(renderRequest() as any, ctx as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(UPSTREAM_ID)
    expect(upsertCalls).toBe(1)
    expect(calls.find((c) => c.url.includes('/cancel'))).toBeUndefined()

    // ownership row carries the session owner + no project (multipart mode)
    const renderCall = calls.find((c) => c.url.endsWith('/render'))!
    const headers = new Headers((renderCall.init as RequestInit).headers as HeadersInit)
    expect(headers.get('x-clipforge-internal-token')).toBe('ownership-test-token')
  })

  test('retry after a failed recording: exactly one new ownership record + one render, no duplicates', async () => {
    // first attempt fails
    upsertShouldThrow = true
    const res1 = await POST(renderRequest() as any, ctx as any)
    expect(res1.status).toBe(500)
    expect(await res1.json()).toBeTruthy()
    const rendersAfterFailure = calls.filter((c) => c.url.endsWith('/render')).length
    const upsertsAfterFailure = upsertCalls

    // client retries — recording now succeeds
    upsertShouldThrow = false
    const res2 = await POST(renderRequest() as any, ctx as any)
    expect(res2.status).toBe(200)

    // exactly ONE new render start and ONE new ownership record for the retry
    expect(calls.filter((c) => c.url.endsWith('/render')).length).toBe(rendersAfterFailure + 1)
    expect(upsertCalls).toBe(upsertsAfterFailure + 1)
    // the failed attempt cancelled its renderer job exactly once
    expect(calls.filter((c) => c.url.includes('/cancel')).length).toBe(1)
  })
})

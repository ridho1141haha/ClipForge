import { cookies } from 'next/headers'
import { randomUUID } from 'node:crypto'

// Anonymous session ownership model (Phase 10).
// Each visitor gets an httpOnly cookie `clipforge_sid`. Every Project/Clip/SourceJob
// row stores `ownerId` = session id. All queries MUST be scoped by it.

export const SESSION_COOKIE = 'clipforge_sid'
const ONE_YEAR = 60 * 60 * 24 * 365

/**
 * Read the current session id, creating (and setting) one if absent.
 * In Next.js App Router route handlers, cookies() is writable.
 */
export async function getOrCreateSessionId(): Promise<string> {
  const store = await cookies()
  const existing = store.get(SESSION_COOKIE)?.value
  if (existing && /^[\w-]{8,64}$/.test(existing)) return existing
  const sid = `s-${randomUUID()}`
  try {
    store.set({
      name: SESSION_COOKIE,
      value: sid,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR,
    })
  } catch {
    // In rare read-only contexts (RSC render) setting throws; caller should
    // treat this as a new session and re-run inside a route handler.
  }
  return sid
}

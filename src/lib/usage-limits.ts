import { db } from '@/lib/db'

/**
 * Usage-based SOFT LIMITS (local mode).
 *
 * A per-session, per-kind daily cap backed by the persisted UsageEvent table —
 * unlike the in-memory burst rate limiter (validation.ts), this survives
 * restarts and reflects real engine load. "Soft" by design:
 *
 *   - the response is a friendly 429 with what happened, when it resets, and
 *     what the user can still do (upload path etc.) — never a dead end
 *   - caps are env-configurable per kind; 0 = unlimited
 *   - counts reset at UTC midnight (documented, deterministic)
 *
 * This is the local-mode skeleton of SaaS plan limits — docs/SAAS-MIGRATION.md
 * §7-8 describes the 1:1 migration (ownerId → workspace/plan lookup).
 */

export type LimitKind = 'analyze' | 'prepare' | 'render' | 'transcribe'

/** Default daily caps per engine kind (env-overridable). */
export const DEFAULT_DAILY_LIMITS: Record<LimitKind, number> = {
  analyze: 60,
  prepare: 30,
  render: 40,
  transcribe: 30,
}

export const DAILY_LIMIT_ENV: Record<LimitKind, string> = {
  analyze: 'CLIPFORGE_DAILY_LIMIT_ANALYZE',
  prepare: 'CLIPFORGE_DAILY_LIMIT_PREPARE',
  render: 'CLIPFORGE_DAILY_LIMIT_RENDER',
  transcribe: 'CLIPFORGE_DAILY_LIMIT_TRANSCRIBE',
}

/** Parse per-kind daily caps from env. Invalid/negative → default; 0 → unlimited. */
export function parseDailyLimits(env: Record<string, string | undefined> = process.env): Record<LimitKind, number> {
  const out = { ...DEFAULT_DAILY_LIMITS }
  for (const kind of Object.keys(DEFAULT_DAILY_LIMITS) as LimitKind[]) {
    const raw = env[DAILY_LIMIT_ENV[kind]]
    if (raw === undefined || raw === '') continue
    const n = Number(raw)
    if (!isFinite(n) || n < 0) continue
    out[kind] = Math.round(n)
  }
  return out
}

/** Start of the UTC day containing `d` (epoch ms). */
export function startOfUtcDay(d: Date = new Date()): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Next UTC midnight after `d` (epoch ms) — when daily counters reset. */
export function nextUtcMidnight(d: Date = new Date()): number {
  return startOfUtcDay(d) + 24 * 3600_000
}

export interface LimitCheck {
  allowed: boolean
  used: number
  cap: number
  remaining: number
  resetAt: number // epoch ms
}

/**
 * Pure limit evaluation — same semantics for all routes:
 * cap <= 0 → unlimited (always allowed, remaining = Infinity is not JSON-safe
 * so it is reported as `cap`).
 */
export function evaluateDailyLimit(used: number, cap: number, now: Date = new Date()): LimitCheck {
  const resetAt = nextUtcMidnight(now)
  if (cap <= 0) return { allowed: true, used, cap: 0, remaining: -1, resetAt }
  const allowed = used < cap
  return { allowed, used, cap, remaining: Math.max(0, cap - used), resetAt }
}

/** Count today's (UTC) UsageEvents for owner+kind. */
export async function usedToday(ownerId: string, kind: LimitKind): Promise<number> {
  const since = new Date(startOfUtcDay())
  const rows = await db.usageEvent.groupBy({
    by: ['kind'],
    _sum: { quantity: true },
    where: { ownerId, kind, createdAt: { gte: since } },
  })
  const q = rows[0]?._sum?.quantity ?? 0
  return Math.round(q * 100) / 100
}

/** DB-backed daily limit check for an owner+kind. Never throws (fail-open: metering/limits must not break the engine). */
export async function checkDailyUsageLimit(ownerId: string, kind: LimitKind, env: Record<string, string | undefined> = process.env): Promise<LimitCheck> {
  try {
    const caps = parseDailyLimits(env)
    const used = await usedToday(ownerId, kind)
    return evaluateDailyLimit(used, caps[kind])
  } catch {
    // fail-open: a limits-check outage must never take the product down
    return { allowed: true, used: 0, cap: 0, remaining: -1, resetAt: nextUtcMidnight() }
  }
}

/** Friendly, actionable 429 body — never a dead end. */
export function limitReachedMessage(kind: LimitCheck & { kind: LimitKind }): string {
  const reset = new Date(kind.resetAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const action: Record<LimitKind, string> = {
    analyze: 'AI clip analysis',
    prepare: 'source preparation (metadata + captions + download)',
    render: 'MP4 renders',
    transcribe: 'ASR transcription',
  }
  return (
    `Daily limit reached for ${action[kind.kind]} (${kind.used}/${kind.cap} today). ` +
    `Counters reset at ${reset}. ` +
    `You can keep editing, exporting, and previewing — only new runs of ${action[kind.kind]} are paused. ` +
    `Self-host: raise the cap via ${DAILY_LIMIT_ENV[kind.kind]}=0 (unlimited).`
  )
}

/** Response headers for limit states. */
export function limitHeaders(check: LimitCheck): Record<string, string> {
  const h: Record<string, string> = {
    'X-RateLimit-Reset': String(Math.ceil(check.resetAt / 1000)),
  }
  if (check.cap > 0) {
    h['X-RateLimit-Limit'] = String(check.cap)
    h['X-RateLimit-Remaining'] = String(Math.max(0, check.remaining))
  }
  if (!check.allowed) {
    h['Retry-After'] = String(Math.max(1, Math.ceil((check.resetAt - Date.now()) / 1000)))
  }
  return h
}

/** Today's per-kind usage vs caps for the UI meter. */
export async function getTodayLimitStatus(ownerId: string, env: Record<string, string | undefined> = process.env) {
  const caps = parseDailyLimits(env)
  const kinds = Object.keys(caps) as LimitKind[]
  const out: Record<string, LimitCheck> = {}
  for (const kind of kinds) {
    try {
      const used = await usedToday(ownerId, kind)
      out[kind] = evaluateDailyLimit(used, caps[kind])
    } catch {
      out[kind] = { allowed: true, used: 0, cap: caps[kind], remaining: -1, resetAt: nextUtcMidnight() }
    }
  }
  return out
}

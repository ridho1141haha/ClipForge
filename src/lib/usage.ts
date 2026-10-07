import { db } from '@/lib/db'

/**
 * Usage metering (light). One row per billable engine action.
 * Fire-and-forget: metering MUST never break the main flow (best-effort insert).
 * Designed to migrate 1:1 to a workspace/user model — see docs/SAAS-MIGRATION.md §7-8.
 */
export type UsageKind = 'analyze' | 'transcribe' | 'render' | 'prepare'

export interface UsageMeta {
  model?: string
  mediaSeconds?: number
  renderSeconds?: number
  projectId?: string
  [k: string]: unknown
}

export async function recordUsage(ownerId: string, kind: UsageKind, quantity = 1, meta?: UsageMeta): Promise<void> {
  try {
    await db.usageEvent.create({
      data: {
        ownerId,
        kind,
        quantity: Math.max(0, Math.round(quantity * 100) / 100),
        meta: meta ? JSON.stringify(meta) : null,
      },
    })
  } catch {
    // metering is best-effort; never fail the main flow
  }
}

export interface UsageSummary {
  totals: { kind: string; count: number; quantity: number }[]
  last30d: { kind: string; count: number; quantity: number }[]
  events: { id: string; kind: string; quantity: number; meta: unknown; createdAt: string }[]
}

export async function getUsageSummary(ownerId: string): Promise<UsageSummary> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const [all, recent] = await Promise.all([
    db.usageEvent.groupBy({ by: ['kind'], _count: { _all: true }, _sum: { quantity: true }, where: { ownerId } }),
    db.usageEvent.groupBy({ by: ['kind'], _count: { _all: true }, _sum: { quantity: true }, where: { ownerId, createdAt: { gte: since } } }),
  ])
  const events = await db.usageEvent.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return {
    totals: all.map((g) => ({ kind: g.kind, count: g._count._all, quantity: g._sum.quantity ?? 0 })),
    last30d: recent.map((g) => ({ kind: g.kind, count: g._count._all, quantity: g._sum.quantity ?? 0 })),
    events: events.map((ev) => ({
      id: ev.id,
      kind: ev.kind,
      quantity: ev.quantity,
      meta: ev.meta ? safeParse(ev.meta) : null,
      createdAt: ev.createdAt.toISOString(),
    })),
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

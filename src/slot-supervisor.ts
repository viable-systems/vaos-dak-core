import { createHash } from 'crypto'

export interface ComputeAutonomySlotOptions {
  epochIso?: string
  intervalSeconds?: number
}

export interface AutonomySlot {
  epochIso: string
  intervalSeconds: number
  slotNumber: number
  slotId: string
  slotStartedAt: string
  slotEndsAt: string
  driftMs: number
}

function normalizeEpoch(epochIso: string | undefined): string {
  if (!epochIso) {
    return '2026-01-01T00:00:00.000Z'
  }
  const value = new Date(epochIso)
  if (Number.isNaN(value.getTime())) {
    return '2026-01-01T00:00:00.000Z'
  }
  return value.toISOString()
}

function normalizeIntervalSeconds(intervalSeconds: number | undefined): number {
  if (!Number.isFinite(intervalSeconds) || (intervalSeconds as number) <= 0) {
    return 60
  }
  return Math.max(5, Math.floor(intervalSeconds as number))
}

export function computeAutonomySlot(now: Date, options: ComputeAutonomySlotOptions = {}): AutonomySlot {
  const epochIso = normalizeEpoch(options.epochIso)
  const intervalSeconds = normalizeIntervalSeconds(options.intervalSeconds)
  const epochMs = new Date(epochIso).getTime()
  const intervalMs = intervalSeconds * 1000
  const delta = Math.max(0, now.getTime() - epochMs)
  const slotNumber = Math.floor(delta / intervalMs)
  const slotStartMs = epochMs + (slotNumber * intervalMs)
  const slotEndMs = slotStartMs + intervalMs
  const slotId = createHash('sha256')
    .update(`${epochIso}|${intervalSeconds}|${slotNumber}`)
    .digest('hex')
    .slice(0, 24)

  return {
    epochIso,
    intervalSeconds,
    slotNumber,
    slotId,
    slotStartedAt: new Date(slotStartMs).toISOString(),
    slotEndsAt: new Date(slotEndMs).toISOString(),
    driftMs: now.getTime() - slotStartMs
  }
}

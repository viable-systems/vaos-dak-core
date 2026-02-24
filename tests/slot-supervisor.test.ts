import { describe, expect, it } from 'vitest'

import { computeAutonomySlot } from '../src/slot-supervisor'

describe('computeAutonomySlot', () => {
  it('produces deterministic slot ids for identical inputs', () => {
    const now = new Date('2026-02-24T12:00:30.000Z')
    const first = computeAutonomySlot(now, {
      epochIso: '2026-02-24T12:00:00.000Z',
      intervalSeconds: 60
    })
    const second = computeAutonomySlot(now, {
      epochIso: '2026-02-24T12:00:00.000Z',
      intervalSeconds: 60
    })

    expect(first.slotNumber).toBe(0)
    expect(first.slotId).toBe(second.slotId)
    expect(first.slotStartedAt).toBe('2026-02-24T12:00:00.000Z')
    expect(first.slotEndsAt).toBe('2026-02-24T12:01:00.000Z')
    expect(first.driftMs).toBe(30_000)
  })

  it('advances slot number as time passes', () => {
    const slot = computeAutonomySlot(new Date('2026-02-24T12:02:10.000Z'), {
      epochIso: '2026-02-24T12:00:00.000Z',
      intervalSeconds: 60
    })

    expect(slot.slotNumber).toBe(2)
    expect(slot.slotStartedAt).toBe('2026-02-24T12:02:00.000Z')
    expect(slot.driftMs).toBe(10_000)
  })
})

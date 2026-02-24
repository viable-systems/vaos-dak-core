import { computeAutonomyDigest } from './hash'
import type { AutonomyEvent } from './types'

const ADAPTATION_POLICIES = [
  'scope.narrow_context',
  'execution.reduce_step_size',
  'safety.require_explicit_checks'
] as const

export type AdaptationPolicyId = typeof ADAPTATION_POLICIES[number]

export interface BoundedAdaptationInput {
  events: AutonomyEvent[]
  errorMessage: string
  maxAttempts?: number
}

export interface BoundedAdaptationDecision {
  applied: boolean
  exhausted: boolean
  priorAttempts: number
  attempt: number
  maxAttempts: number
  policyId: AdaptationPolicyId | null
  errorDigest: string
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 3
  }
  return Math.floor(value)
}

function countPriorAdaptationAttempts(events: AutonomyEvent[]): number {
  const uniqueAttemptKeys = new Set<string>()

  for (const event of events) {
    if (event.event_type !== 'adaptation.applied') {
      continue
    }

    uniqueAttemptKeys.add(event.idempotency_key)
  }

  return uniqueAttemptKeys.size
}

function selectAdaptationPolicy(attempt: number): AdaptationPolicyId {
  const index = (attempt - 1) % ADAPTATION_POLICIES.length
  return ADAPTATION_POLICIES[index]
}

export function computeBoundedAdaptationDecision(
  input: BoundedAdaptationInput
): BoundedAdaptationDecision {
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts)
  const priorAttempts = countPriorAdaptationAttempts(input.events)
  const nextAttempt = priorAttempts + 1
  const errorDigest = computeAutonomyDigest({
    error: input.errorMessage,
    prior_attempts: priorAttempts
  })

  if (nextAttempt > maxAttempts) {
    return {
      applied: false,
      exhausted: true,
      priorAttempts,
      attempt: priorAttempts,
      maxAttempts,
      policyId: null,
      errorDigest
    }
  }

  return {
    applied: true,
    exhausted: false,
    priorAttempts,
    attempt: nextAttempt,
    maxAttempts,
    policyId: selectAdaptationPolicy(nextAttempt),
    errorDigest
  }
}

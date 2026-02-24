export interface EvaluateAutonomyWritePolicyInput {
  eventType: string
  actorType?: string | null
}

export interface AutonomyWritePolicyDecision {
  allowed: boolean
  reason?: string
}

const SYSTEM_ONLY_EVENT_TYPES = new Set<string>([
  'stream.started',
  'step.succeeded',
  'retry.scheduled',
  'adaptation.applied',
  'stream.completed',
  'stream.failed_terminal',
  'stream.marked_inconsistent'
])

export function evaluateAutonomyWritePolicy(
  input: EvaluateAutonomyWritePolicyInput
): AutonomyWritePolicyDecision {
  if (input.eventType === 'policy.violation') {
    return { allowed: true }
  }

  if (SYSTEM_ONLY_EVENT_TYPES.has(input.eventType) && input.actorType !== 'system') {
    return {
      allowed: false,
      reason: `event_type_requires_system_actor:${input.eventType}`
    }
  }

  return { allowed: true }
}

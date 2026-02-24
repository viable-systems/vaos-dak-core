import type { AutonomyWorkflowType } from './types'

export const AUTONOMY_WORKFLOW_PHASES: Record<AutonomyWorkflowType, string[]> = {
  provisioning: ['pending', 'creating', 'installing', 'ready'],
  factory: ['queued', 'research', 'plan', 'implement', 'critique', 'completed']
}

export function defaultPhaseForWorkflow(workflowType: AutonomyWorkflowType): string {
  return AUTONOMY_WORKFLOW_PHASES[workflowType][0]
}

export function terminalPhaseForWorkflow(workflowType: AutonomyWorkflowType): string {
  const phases = AUTONOMY_WORKFLOW_PHASES[workflowType]
  return phases[phases.length - 1]
}

export function isTerminalPhase(workflowType: AutonomyWorkflowType, phase: string): boolean {
  return phase === terminalPhaseForWorkflow(workflowType)
}

export function nextPhaseForWorkflow(workflowType: AutonomyWorkflowType, phase: string): string | null {
  const phases = AUTONOMY_WORKFLOW_PHASES[workflowType]
  const idx = phases.indexOf(phase)
  if (idx === -1 || idx >= phases.length - 1) {
    return null
  }
  return phases[idx + 1]
}


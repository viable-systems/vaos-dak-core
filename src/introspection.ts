import { retrieveAutonomyMemory, type RetrievedMemoryContext } from './memory'
import { reduceAutonomyStream, type ReducedAutonomyState } from './reducer'
import type { AutonomyRepository } from './repository-types'
import type {
  AutonomyDeadLetter,
  AutonomyEvent,
  AutonomyLease,
  AutonomySnapshot,
  AutonomyStream
} from './types'

export type AutonomyInspectionStatus = 'ok' | 'unknown_stream' | 'inconsistent_stream'

export interface AutonomyStreamInspection {
  status: AutonomyInspectionStatus
  streamId: string
  stream: AutonomyStream | null
  reducedState: ReducedAutonomyState | null
  lastEvent: AutonomyEvent | null
  lease: AutonomyLease | null
  snapshot: AutonomySnapshot | null
  deadLetter: AutonomyDeadLetter | null
  errorSummary: string | null
  memoryContext: RetrievedMemoryContext | null
}

export interface AutonomyInspectionOptions {
  query?: string
}

export class AutonomyIntrospectionService {
  constructor(private readonly repository: AutonomyRepository) {}

  async inspectStream(streamId: string, options: AutonomyInspectionOptions = {}): Promise<AutonomyStreamInspection> {
    const stream = await this.repository.getStream(streamId)
    if (!stream) {
      return {
        status: 'unknown_stream',
        streamId,
        stream: null,
        reducedState: null,
        lastEvent: null,
        lease: null,
        snapshot: null,
        deadLetter: null,
        errorSummary: null,
        memoryContext: null
      }
    }

    const [events, lease, snapshot, deadLetter] = await Promise.all([
      this.repository.getEvents(streamId),
      this.repository.getLease(streamId),
      this.repository.getLatestSnapshot(streamId),
      this.repository.getLatestDeadLetter(streamId)
    ])

    const reducedState = reduceAutonomyStream(stream, events)
    const lastEvent = events.length > 0 ? events[events.length - 1] : null
    const inconsistent = stream.status === 'inconsistent' || reducedState.inconsistent
    const errorSummary = stream.last_error || deadLetter?.last_error || reducedState.reason || null
    const memoryContext = retrieveAutonomyMemory({
      stream,
      events,
      query: options.query,
      limit: 5
    })

    return {
      status: inconsistent ? 'inconsistent_stream' : 'ok',
      streamId,
      stream,
      reducedState,
      lastEvent,
      lease,
      snapshot,
      deadLetter,
      errorSummary,
      memoryContext
    }
  }
}

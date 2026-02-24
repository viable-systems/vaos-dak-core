import type {
  AutonomyDeadLetter,
  AutonomyEvent,
  AutonomyLease,
  AutonomySnapshot,
  AutonomyStream,
  AutonomyStreamUpdate,
  NewAutonomyDeadLetter,
  NewAutonomyEvent,
  NewAutonomyLease,
  NewAutonomySnapshot,
} from './types'

export type AutonomyRepositoryErrorCode =
  | 'not_found'
  | 'conflict'
  | 'database_error'
  | 'invalid_data'

export class AutonomyRepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: AutonomyRepositoryErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AutonomyRepositoryError'
  }
}

export interface AutonomyRepository {
  streamExists(streamId: string): Promise<boolean>
  getStream(streamId: string): Promise<AutonomyStream | null>
  updateStream(streamId: string, changes: AutonomyStreamUpdate): Promise<AutonomyStream | null>
  listRunnableStreams(now: Date, limit: number): Promise<AutonomyStream[]>
  getEvents(streamId: string): Promise<AutonomyEvent[]>
  getEventsAfterSequence(streamId: string, afterSeqNo: number): Promise<AutonomyEvent[]>
  getLatestEvent(streamId: string): Promise<AutonomyEvent | null>
  getEventByIdempotencyKey(streamId: string, idempotencyKey: string): Promise<AutonomyEvent | null>
  insertEvent(event: NewAutonomyEvent): Promise<AutonomyEvent>
  advanceStreamSequence(streamId: string, nextSeqNo: number): Promise<void>

  getLease(streamId: string): Promise<AutonomyLease | null>
  createLease(lease: NewAutonomyLease): Promise<AutonomyLease>
  updateLeaseIfCurrentHolder(
    streamId: string,
    expectedWorkerId: string,
    nextLease: NewAutonomyLease
  ): Promise<AutonomyLease | null>
  deleteLease(streamId: string, workerId: string): Promise<boolean>

  insertDeadLetter(record: NewAutonomyDeadLetter): Promise<AutonomyDeadLetter>
  getLatestDeadLetter(streamId: string): Promise<AutonomyDeadLetter | null>

  upsertSnapshot(snapshot: NewAutonomySnapshot): Promise<AutonomySnapshot>
  getLatestSnapshot(streamId: string): Promise<AutonomySnapshot | null>
}

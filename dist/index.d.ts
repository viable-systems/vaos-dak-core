type AutonomyWorkflowType = 'provisioning' | 'factory';
type AutonomyStreamStatus = 'pending' | 'running' | 'retry_scheduled' | 'completed' | 'failed_terminal' | 'inconsistent';
interface AutonomyStream {
    id: string;
    workflow_type: AutonomyWorkflowType;
    owner_user_id: string;
    status: AutonomyStreamStatus;
    current_state: Record<string, unknown>;
    last_seq_no: number;
    retry_count: number;
    max_retries: number;
    next_tick_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
}
interface AutonomyStreamUpdate {
    status?: AutonomyStreamStatus;
    current_state?: Record<string, unknown>;
    retry_count?: number;
    max_retries?: number;
    next_tick_at?: string | null;
    last_error?: string | null;
    last_seq_no?: number;
}
interface AutonomyEvent {
    id: string;
    stream_id: string;
    seq_no: number;
    event_type: string;
    payload_json: Record<string, unknown>;
    metadata_json: Record<string, unknown>;
    idempotency_key: string;
    prev_hash: string | null;
    event_hash: string;
    actor_type: string | null;
    actor_id: string | null;
    created_at: string;
}
interface NewAutonomyEvent {
    stream_id: string;
    seq_no: number;
    event_type: string;
    payload_json: Record<string, unknown>;
    metadata_json: Record<string, unknown>;
    idempotency_key: string;
    prev_hash: string | null;
    event_hash: string;
    actor_type: string | null;
    actor_id: string | null;
    created_at: string;
}
interface AutonomyLease {
    stream_id: string;
    worker_id: string;
    lease_expires_at: string;
    heartbeat_at: string;
    created_at: string;
    updated_at: string;
}
interface NewAutonomyLease {
    stream_id: string;
    worker_id: string;
    lease_expires_at: string;
    heartbeat_at: string;
}
interface AutonomyDeadLetter {
    id: string;
    stream_id: string;
    terminal_reason: string;
    attempts: number;
    last_error: string | null;
    last_event_id: string | null;
    created_at: string;
}
interface NewAutonomyDeadLetter {
    stream_id: string;
    terminal_reason: string;
    attempts: number;
    last_error?: string | null;
    last_event_id?: string | null;
}
interface AutonomySnapshotState {
    status: AutonomyStreamStatus;
    phase: string;
    retry_count: number;
    last_error: string | null;
    workflow_type: AutonomyWorkflowType;
}
interface AutonomySnapshot {
    id: string;
    stream_id: string;
    last_seq_no: number;
    state_blob: AutonomySnapshotState;
    state_hash: string;
    created_at: string;
    updated_at: string;
}
interface NewAutonomySnapshot {
    stream_id: string;
    last_seq_no: number;
    state_blob: AutonomySnapshotState;
    state_hash: string;
}
interface AppendEventInput {
    streamId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
    actorType?: string | null;
    actorId?: string | null;
    createdAt?: string;
}
interface AppendEventResult {
    event: AutonomyEvent;
    deduplicated: boolean;
}
interface AcquireLeaseInput {
    streamId: string;
    workerId: string;
    leaseTtlMs: number;
    now?: Date;
}
interface AcquireLeaseResult {
    acquired: boolean;
    lease: AutonomyLease | null;
    reason?: 'held_by_other' | 'stream_not_found';
}

declare const ADAPTATION_POLICIES: readonly ["scope.narrow_context", "execution.reduce_step_size", "safety.require_explicit_checks"];
type AdaptationPolicyId = typeof ADAPTATION_POLICIES[number];
interface BoundedAdaptationInput {
    events: AutonomyEvent[];
    errorMessage: string;
    maxAttempts?: number;
}
interface BoundedAdaptationDecision {
    applied: boolean;
    exhausted: boolean;
    priorAttempts: number;
    attempt: number;
    maxAttempts: number;
    policyId: AdaptationPolicyId | null;
    errorDigest: string;
}
declare function computeBoundedAdaptationDecision(input: BoundedAdaptationInput): BoundedAdaptationDecision;

interface ConceptNode {
    concept: string;
    frequency: number;
    lastSeenSeqNo: number;
}
type ThreadEdgeReason = 'adjacent' | 'shared_concept';
interface ThreadEdge {
    fromSeqNo: number;
    toSeqNo: number;
    reasons: ThreadEdgeReason[];
    sharedConcepts: string[];
    weight: number;
}
interface EventConceptProjection {
    seqNo: number;
    eventType: string;
    concepts: string[];
    excerpt: string;
}
interface ConceptThreadGraph {
    events: EventConceptProjection[];
    concepts: ConceptNode[];
    edges: ThreadEdge[];
}
interface RetrievedMemoryItem {
    seqNo: number;
    eventType: string;
    concepts: string[];
    overlapConcepts: string[];
    score: number;
    excerpt: string;
}
interface RetrievedMemoryContext {
    query: string;
    queryTokens: string[];
    graph: {
        eventCount: number;
        conceptCount: number;
        edgeCount: number;
        topConcepts: string[];
    };
    items: RetrievedMemoryItem[];
    threadEdges: ThreadEdge[];
}
interface RetrieveAutonomyMemoryInput {
    stream: AutonomyStream;
    events: AutonomyEvent[];
    query?: string;
    limit?: number;
}
declare function extractConceptTokens(input: string, maxTokens?: number): string[];
declare function buildConceptThreadGraph(events: AutonomyEvent[]): ConceptThreadGraph;
declare function retrieveAutonomyMemory(input: RetrieveAutonomyMemoryInput): RetrievedMemoryContext;

declare const AUTONOMY_WORKFLOW_PHASES: Record<AutonomyWorkflowType, string[]>;
declare function defaultPhaseForWorkflow(workflowType: AutonomyWorkflowType): string;
declare function terminalPhaseForWorkflow(workflowType: AutonomyWorkflowType): string;
declare function isTerminalPhase(workflowType: AutonomyWorkflowType, phase: string): boolean;
declare function nextPhaseForWorkflow(workflowType: AutonomyWorkflowType, phase: string): string | null;

interface EvaluateAutonomyWritePolicyInput {
    eventType: string;
    actorType?: string | null;
}
interface AutonomyWritePolicyDecision {
    allowed: boolean;
    reason?: string;
}
declare function evaluateAutonomyWritePolicy(input: EvaluateAutonomyWritePolicyInput): AutonomyWritePolicyDecision;

interface ReducedAutonomyState {
    streamId: string;
    workflowType: AutonomyStream['workflow_type'];
    status: AutonomyStreamStatus;
    phase: string;
    retryCount: number;
    lastSeqNo: number;
    lastError: string | null;
    inconsistent: boolean;
    reason?: string;
}
interface ReduceAutonomyStreamOptions {
    startSeqNo?: number;
    seedState?: Partial<Pick<ReducedAutonomyState, 'status' | 'phase' | 'retryCount' | 'lastError' | 'lastSeqNo'>>;
}
declare function reduceAutonomyStream(stream: AutonomyStream, events: AutonomyEvent[], options?: ReduceAutonomyStreamOptions): ReducedAutonomyState;

declare function computeRetryBackoffMs(attempt: number): number;

type AutonomyRepositoryErrorCode = 'not_found' | 'conflict' | 'database_error' | 'invalid_data';
declare class AutonomyRepositoryError extends Error {
    readonly code: AutonomyRepositoryErrorCode;
    readonly details?: Record<string, unknown> | undefined;
    constructor(message: string, code: AutonomyRepositoryErrorCode, details?: Record<string, unknown> | undefined);
}
interface AutonomyRepository {
    streamExists(streamId: string): Promise<boolean>;
    getStream(streamId: string): Promise<AutonomyStream | null>;
    updateStream(streamId: string, changes: AutonomyStreamUpdate): Promise<AutonomyStream | null>;
    listRunnableStreams(now: Date, limit: number): Promise<AutonomyStream[]>;
    getEvents(streamId: string): Promise<AutonomyEvent[]>;
    getEventsAfterSequence(streamId: string, afterSeqNo: number): Promise<AutonomyEvent[]>;
    getLatestEvent(streamId: string): Promise<AutonomyEvent | null>;
    getEventByIdempotencyKey(streamId: string, idempotencyKey: string): Promise<AutonomyEvent | null>;
    insertEvent(event: NewAutonomyEvent): Promise<AutonomyEvent>;
    advanceStreamSequence(streamId: string, nextSeqNo: number): Promise<void>;
    getLease(streamId: string): Promise<AutonomyLease | null>;
    createLease(lease: NewAutonomyLease): Promise<AutonomyLease>;
    updateLeaseIfCurrentHolder(streamId: string, expectedWorkerId: string, nextLease: NewAutonomyLease): Promise<AutonomyLease | null>;
    deleteLease(streamId: string, workerId: string): Promise<boolean>;
    insertDeadLetter(record: NewAutonomyDeadLetter): Promise<AutonomyDeadLetter>;
    getLatestDeadLetter(streamId: string): Promise<AutonomyDeadLetter | null>;
    upsertSnapshot(snapshot: NewAutonomySnapshot): Promise<AutonomySnapshot>;
    getLatestSnapshot(streamId: string): Promise<AutonomySnapshot | null>;
}

type AutonomyInspectionStatus = 'ok' | 'unknown_stream' | 'inconsistent_stream';
interface AutonomyStreamInspection {
    status: AutonomyInspectionStatus;
    streamId: string;
    stream: AutonomyStream | null;
    reducedState: ReducedAutonomyState | null;
    lastEvent: AutonomyEvent | null;
    lease: AutonomyLease | null;
    snapshot: AutonomySnapshot | null;
    deadLetter: AutonomyDeadLetter | null;
    errorSummary: string | null;
    memoryContext: RetrievedMemoryContext | null;
}
interface AutonomyInspectionOptions {
    query?: string;
}
declare class AutonomyIntrospectionService {
    private readonly repository;
    constructor(repository: AutonomyRepository);
    inspectStream(streamId: string, options?: AutonomyInspectionOptions): Promise<AutonomyStreamInspection>;
}

declare class AutonomyLeaseManager {
    private readonly repository;
    constructor(repository: AutonomyRepository);
    acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult>;
    heartbeatLease(streamId: string, workerId: string, leaseTtlMs: number, now?: Date): Promise<AutonomyLease | null>;
    releaseLease(streamId: string, workerId: string): Promise<boolean>;
}

declare class AutonomyPolicyViolationError extends Error {
    readonly reason: string;
    constructor(message: string, reason: string);
}
declare class AutonomyLedgerService {
    private readonly repository;
    constructor(repository: AutonomyRepository);
    appendEvent(input: AppendEventInput): Promise<AppendEventResult>;
    private appendPolicyViolation;
}

interface ComputeAutonomySlotOptions {
    epochIso?: string;
    intervalSeconds?: number;
}
interface AutonomySlot {
    epochIso: string;
    intervalSeconds: number;
    slotNumber: number;
    slotId: string;
    slotStartedAt: string;
    slotEndsAt: string;
    driftMs: number;
}
declare function computeAutonomySlot(now: Date, options?: ComputeAutonomySlotOptions): AutonomySlot;

interface TransitionExecutionInput {
    stream: AutonomyStream;
    fromPhase: string;
    toPhase: string;
    tickId: string;
    now: Date;
    memoryContext?: RetrievedMemoryContext;
}
type TransitionExecutor = (input: TransitionExecutionInput) => Promise<void> | void;
interface RunTickInput {
    streamId: string;
    tickId?: string;
    now?: Date;
}
type TickOutcome = 'processed' | 'completed' | 'retry_scheduled' | 'failed_terminal' | 'inconsistent_stream' | 'already_processed' | 'not_runnable' | 'lease_not_acquired' | 'not_found';
interface RunTickResult {
    streamId: string;
    tickId: string;
    outcome: TickOutcome;
    eventType?: string;
    nextTickAt?: string | null;
    retryCount?: number;
    reason?: string;
    durationMs: number;
}
interface ProcessRunnableStreamsInput {
    now?: Date;
    limit?: number;
    slotId?: string;
}
interface ProcessRunnableStreamsResult {
    workerId: string;
    startedAt: string;
    slotId?: string;
    attempted: number;
    processed: number;
    results: RunTickResult[];
}
interface AutonomyTickEngineOptions {
    repository: AutonomyRepository;
    ledger: AutonomyLedgerService;
    leaseManager: AutonomyLeaseManager;
    workerId?: string;
    leaseTtlMs?: number;
    tickBudgetMs?: number;
    tickDelayMs?: number;
    snapshotInterval?: number;
    maxAdaptationAttempts?: number;
    transitionExecutor?: TransitionExecutor;
    clock?: () => Date;
}
declare class AutonomyTickEngine {
    private readonly options;
    private readonly workerId;
    private readonly leaseTtlMs;
    private readonly tickBudgetMs;
    private readonly tickDelayMs;
    private readonly snapshotInterval;
    private readonly maxAdaptationAttempts;
    private readonly transitionExecutor;
    private readonly clock;
    constructor(options: AutonomyTickEngineOptions);
    processRunnableStreams(input?: ProcessRunnableStreamsInput): Promise<ProcessRunnableStreamsResult>;
    runTick(input: RunTickInput): Promise<RunTickResult>;
    private runTickWithLease;
    private handleTransitionFailure;
    private maybePersistSnapshot;
}

declare class InMemoryAutonomyRepository implements AutonomyRepository {
    private streams;
    private eventsByStream;
    private leases;
    private deadLettersByStream;
    private snapshotsByStream;
    createStream(stream: Pick<AutonomyStream, 'id' | 'workflow_type' | 'owner_user_id'> & Partial<AutonomyStream>): AutonomyStream;
    streamExists(streamId: string): Promise<boolean>;
    getStream(streamId: string): Promise<AutonomyStream | null>;
    updateStream(streamId: string, changes: AutonomyStreamUpdate): Promise<AutonomyStream | null>;
    listRunnableStreams(now: Date, limit: number): Promise<AutonomyStream[]>;
    getEvents(streamId: string): Promise<AutonomyEvent[]>;
    getEventsAfterSequence(streamId: string, afterSeqNo: number): Promise<AutonomyEvent[]>;
    getLatestEvent(streamId: string): Promise<AutonomyEvent | null>;
    getEventByIdempotencyKey(streamId: string, idempotencyKey: string): Promise<AutonomyEvent | null>;
    insertEvent(event: NewAutonomyEvent): Promise<AutonomyEvent>;
    advanceStreamSequence(streamId: string, nextSeqNo: number): Promise<void>;
    getLease(streamId: string): Promise<AutonomyLease | null>;
    createLease(lease: NewAutonomyLease): Promise<AutonomyLease>;
    updateLeaseIfCurrentHolder(streamId: string, expectedWorkerId: string, nextLease: NewAutonomyLease): Promise<AutonomyLease | null>;
    deleteLease(streamId: string, workerId: string): Promise<boolean>;
    insertDeadLetter(record: NewAutonomyDeadLetter): Promise<AutonomyDeadLetter>;
    getLatestDeadLetter(streamId: string): Promise<AutonomyDeadLetter | null>;
    upsertSnapshot(snapshot: NewAutonomySnapshot): Promise<AutonomySnapshot>;
    getLatestSnapshot(streamId: string): Promise<AutonomySnapshot | null>;
}

interface SupabaseAutonomyQueryClient {
    from(table: string): SupabaseAutonomyQueryBuilder;
}
interface SupabaseAutonomyQueryResult {
    data?: unknown;
    error?: unknown;
}
type SupabaseAutonomyQueryBuilder = PromiseLike<SupabaseAutonomyQueryResult> & {
    select(columns: string): SupabaseAutonomyQueryBuilder;
    update(values: object): SupabaseAutonomyQueryBuilder;
    insert(values: object | object[]): SupabaseAutonomyQueryBuilder;
    upsert(values: object | object[], options?: Record<string, unknown>): SupabaseAutonomyQueryBuilder;
    delete(): SupabaseAutonomyQueryBuilder;
    eq(column: string, value: unknown): SupabaseAutonomyQueryBuilder;
    gt(column: string, value: unknown): SupabaseAutonomyQueryBuilder;
    lt(column: string, value: unknown): SupabaseAutonomyQueryBuilder;
    lte(column: string, value: unknown): SupabaseAutonomyQueryBuilder;
    in(column: string, values: unknown[]): SupabaseAutonomyQueryBuilder;
    order(column: string, options?: {
        ascending?: boolean;
    }): SupabaseAutonomyQueryBuilder;
    limit(count: number): SupabaseAutonomyQueryBuilder;
    maybeSingle(): Promise<SupabaseAutonomyQueryResult>;
    single(): Promise<SupabaseAutonomyQueryResult>;
};
declare class SupabaseAutonomyRepository implements AutonomyRepository {
    private readonly client;
    constructor(client: SupabaseAutonomyQueryClient);
    streamExists(streamId: string): Promise<boolean>;
    getStream(streamId: string): Promise<AutonomyStream | null>;
    updateStream(streamId: string, changes: AutonomyStreamUpdate): Promise<AutonomyStream | null>;
    listRunnableStreams(now: Date, limit: number): Promise<AutonomyStream[]>;
    getEvents(streamId: string): Promise<AutonomyEvent[]>;
    getEventsAfterSequence(streamId: string, afterSeqNo: number): Promise<AutonomyEvent[]>;
    getLatestEvent(streamId: string): Promise<AutonomyEvent | null>;
    getEventByIdempotencyKey(streamId: string, idempotencyKey: string): Promise<AutonomyEvent | null>;
    insertEvent(event: NewAutonomyEvent): Promise<AutonomyEvent>;
    advanceStreamSequence(streamId: string, nextSeqNo: number): Promise<void>;
    getLease(streamId: string): Promise<AutonomyLease | null>;
    createLease(lease: NewAutonomyLease): Promise<AutonomyLease>;
    updateLeaseIfCurrentHolder(streamId: string, expectedWorkerId: string, nextLease: NewAutonomyLease): Promise<AutonomyLease | null>;
    deleteLease(streamId: string, workerId: string): Promise<boolean>;
    insertDeadLetter(record: NewAutonomyDeadLetter): Promise<AutonomyDeadLetter>;
    getLatestDeadLetter(streamId: string): Promise<AutonomyDeadLetter | null>;
    upsertSnapshot(snapshot: NewAutonomySnapshot): Promise<AutonomySnapshot>;
    getLatestSnapshot(streamId: string): Promise<AutonomySnapshot | null>;
}

declare function computeAutonomyDigest(payload: unknown): string;
declare function computeAutonomyEventHash(event: Omit<NewAutonomyEvent, 'event_hash'>): string;

interface DeterminismReceipt {
    schema_version: string;
    engine_version: string;
    stream_id: string;
    tick_id: string;
    event_count: number;
    first_seq_no: number | null;
    last_seq_no: number | null;
    event_chain_root: string;
    replay_state_hash: string;
    policy_decision_hash: string;
    snapshot_state_hash: string | null;
    generated_at: string;
    signature: string | null;
}
interface BuildDeterminismReceiptInput {
    stream: AutonomyStream;
    events: AutonomyEvent[];
    tickId: string;
    reducedState?: ReducedAutonomyState;
    snapshot?: Pick<AutonomySnapshot, 'state_blob'> | null;
    generatedAt?: string;
    engineVersion?: string;
    signingSecret?: string;
}
interface EventHashChainResult {
    valid: boolean;
    chainRoot: string;
    issues: string[];
}
interface VerifyDeterminismReceiptResult {
    valid: boolean;
    issues: string[];
    expected: DeterminismReceipt;
}
declare function verifyEventHashChain(events: AutonomyEvent[]): EventHashChainResult;
declare function buildDeterminismReceipt(input: BuildDeterminismReceiptInput): DeterminismReceipt;
declare function verifyDeterminismReceipt(receipt: DeterminismReceipt, input: Omit<BuildDeterminismReceiptInput, 'generatedAt'>): VerifyDeterminismReceiptResult;

export { AUTONOMY_WORKFLOW_PHASES, type AcquireLeaseInput, type AcquireLeaseResult, type AdaptationPolicyId, type AppendEventInput, type AppendEventResult, type AutonomyDeadLetter, type AutonomyEvent, type AutonomyInspectionOptions, type AutonomyInspectionStatus, AutonomyIntrospectionService, type AutonomyLease, AutonomyLeaseManager, AutonomyLedgerService, AutonomyPolicyViolationError, type AutonomyRepository, AutonomyRepositoryError, type AutonomyRepositoryErrorCode, type AutonomySlot, type AutonomySnapshot, type AutonomySnapshotState, type AutonomyStream, type AutonomyStreamInspection, type AutonomyStreamStatus, type AutonomyStreamUpdate, AutonomyTickEngine, type AutonomyTickEngineOptions, type AutonomyWorkflowType, type AutonomyWritePolicyDecision, type BoundedAdaptationDecision, type BoundedAdaptationInput, type BuildDeterminismReceiptInput, type ComputeAutonomySlotOptions, type ConceptNode, type ConceptThreadGraph, type DeterminismReceipt, type EvaluateAutonomyWritePolicyInput, type EventConceptProjection, type EventHashChainResult, InMemoryAutonomyRepository, type NewAutonomyDeadLetter, type NewAutonomyEvent, type NewAutonomyLease, type NewAutonomySnapshot, type ProcessRunnableStreamsInput, type ProcessRunnableStreamsResult, type ReduceAutonomyStreamOptions, type ReducedAutonomyState, type RetrieveAutonomyMemoryInput, type RetrievedMemoryContext, type RetrievedMemoryItem, type RunTickInput, type RunTickResult, type SupabaseAutonomyQueryBuilder, type SupabaseAutonomyQueryClient, SupabaseAutonomyRepository, type ThreadEdge, type ThreadEdgeReason, type TickOutcome, type TransitionExecutionInput, type TransitionExecutor, type VerifyDeterminismReceiptResult, buildConceptThreadGraph, buildDeterminismReceipt, computeAutonomyDigest, computeAutonomyEventHash, computeAutonomySlot, computeBoundedAdaptationDecision, computeRetryBackoffMs, defaultPhaseForWorkflow, evaluateAutonomyWritePolicy, extractConceptTokens, isTerminalPhase, nextPhaseForWorkflow, reduceAutonomyStream, retrieveAutonomyMemory, terminalPhaseForWorkflow, verifyDeterminismReceipt, verifyEventHashChain };

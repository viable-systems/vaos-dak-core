// src/hash.ts
import { createHash } from "crypto";
function stableStringify(value) {
  if (value === null || value === void 0) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `"${k}":${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}
function computeAutonomyDigest(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
function computeAutonomyEventHash(event) {
  const canonical = stableStringify({
    stream_id: event.stream_id,
    seq_no: event.seq_no,
    event_type: event.event_type,
    payload_json: event.payload_json,
    metadata_json: event.metadata_json,
    idempotency_key: event.idempotency_key,
    prev_hash: event.prev_hash,
    actor_type: event.actor_type,
    actor_id: event.actor_id,
    created_at: event.created_at
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// src/adaptation.ts
var ADAPTATION_POLICIES = [
  "scope.narrow_context",
  "execution.reduce_step_size",
  "safety.require_explicit_checks"
];
function normalizeMaxAttempts(value) {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 3;
  }
  return Math.floor(value);
}
function countPriorAdaptationAttempts(events) {
  const uniqueAttemptKeys = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.event_type !== "adaptation.applied") {
      continue;
    }
    uniqueAttemptKeys.add(event.idempotency_key);
  }
  return uniqueAttemptKeys.size;
}
function selectAdaptationPolicy(attempt) {
  const index = (attempt - 1) % ADAPTATION_POLICIES.length;
  return ADAPTATION_POLICIES[index];
}
function computeBoundedAdaptationDecision(input) {
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
  const priorAttempts = countPriorAdaptationAttempts(input.events);
  const nextAttempt = priorAttempts + 1;
  const errorDigest = computeAutonomyDigest({
    error: input.errorMessage,
    prior_attempts: priorAttempts
  });
  if (nextAttempt > maxAttempts) {
    return {
      applied: false,
      exhausted: true,
      priorAttempts,
      attempt: priorAttempts,
      maxAttempts,
      policyId: null,
      errorDigest
    };
  }
  return {
    applied: true,
    exhausted: false,
    priorAttempts,
    attempt: nextAttempt,
    maxAttempts,
    policyId: selectAdaptationPolicy(nextAttempt),
    errorDigest
  };
}

// src/memory.ts
var STOP_WORDS = /* @__PURE__ */ new Set([
  "and",
  "the",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "will",
  "have",
  "has",
  "had",
  "not",
  "null",
  "true",
  "false",
  "then",
  "when",
  "where",
  "while",
  "about",
  "after",
  "before",
  "over",
  "under",
  "only",
  "just",
  "than",
  "been",
  "also",
  "each",
  "other",
  "some",
  "more",
  // Event-type boilerplate tokens that create noise for concept ranking.
  "stream",
  "step",
  "started",
  "succeeded",
  "retry",
  "scheduled",
  "completed",
  "failed",
  "terminal",
  "marked",
  "inconsistent",
  "manual",
  "requested"
]);
var TOKEN_PATTERN = /[a-z0-9]+/g;
var MAX_TOKEN_LENGTH = 40;
var MAX_TOKENS_PER_EVENT = 24;
var MAX_SOURCE_DEPTH = 4;
function collectStringFragments(value, sink, depth = 0) {
  if (depth > MAX_SOURCE_DEPTH || value === null || value === void 0) {
    return;
  }
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      sink.push(value.trim());
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    sink.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringFragments(entry, sink, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    for (const [, nested] of entries) {
      collectStringFragments(nested, sink, depth + 1);
    }
  }
}
function normalizeToken(rawToken) {
  const token = rawToken.toLowerCase();
  if (token.length < 3 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  if (STOP_WORDS.has(token)) {
    return null;
  }
  return token;
}
function extractConceptTokens(input, maxTokens = MAX_TOKENS_PER_EVENT) {
  const matches = input.toLowerCase().match(TOKEN_PATTERN) || [];
  const concepts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rawToken of matches) {
    const token = normalizeToken(rawToken);
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    concepts.push(token);
    if (concepts.length >= maxTokens) {
      break;
    }
  }
  return concepts;
}
function eventToProjection(event) {
  const fragments = [event.event_type.replace(/[._]+/g, " ")];
  collectStringFragments(event.payload_json, fragments);
  collectStringFragments(event.metadata_json, fragments);
  const sourceText = fragments.join(" ").replace(/\s+/g, " ").trim();
  return {
    seqNo: event.seq_no,
    eventType: event.event_type,
    concepts: extractConceptTokens(sourceText),
    excerpt: sourceText.slice(0, 220)
  };
}
function upsertEdge(edgeMap, input) {
  if (input.fromSeqNo === input.toSeqNo) {
    return;
  }
  const key = `${input.fromSeqNo}->${input.toSeqNo}`;
  const existing = edgeMap.get(key);
  if (!existing) {
    edgeMap.set(key, {
      fromSeqNo: input.fromSeqNo,
      toSeqNo: input.toSeqNo,
      reasons: [input.reason],
      sharedConcepts: [...input.sharedConcepts].sort(),
      weight: input.weight
    });
    return;
  }
  if (!existing.reasons.includes(input.reason)) {
    existing.reasons.push(input.reason);
    existing.reasons.sort();
  }
  if (input.sharedConcepts.length > 0) {
    const concepts = /* @__PURE__ */ new Set([...existing.sharedConcepts, ...input.sharedConcepts]);
    existing.sharedConcepts = [...concepts].sort();
  }
  existing.weight += input.weight;
  edgeMap.set(key, existing);
}
function sortEvents(events) {
  return [...events].sort((left, right) => left.seq_no - right.seq_no);
}
function buildConceptThreadGraph(events) {
  const orderedEvents = sortEvents(events);
  const projections = orderedEvents.map(eventToProjection);
  const conceptStats = /* @__PURE__ */ new Map();
  const edgeMap = /* @__PURE__ */ new Map();
  const lastSeqByConcept = /* @__PURE__ */ new Map();
  for (let index = 0; index < projections.length; index++) {
    const projection = projections[index];
    const projectionConceptSet = new Set(projection.concepts);
    for (const concept of projection.concepts) {
      const existing = conceptStats.get(concept);
      conceptStats.set(concept, {
        concept,
        frequency: (existing?.frequency || 0) + 1,
        lastSeenSeqNo: projection.seqNo
      });
      const priorSeqNo = lastSeqByConcept.get(concept);
      if (priorSeqNo && priorSeqNo !== projection.seqNo) {
        upsertEdge(edgeMap, {
          fromSeqNo: priorSeqNo,
          toSeqNo: projection.seqNo,
          reason: "shared_concept",
          sharedConcepts: [concept],
          weight: 2
        });
      }
      lastSeqByConcept.set(concept, projection.seqNo);
    }
    if (index > 0) {
      const previous = projections[index - 1];
      const sharedAdjacentConcepts = previous.concepts.filter((concept) => projectionConceptSet.has(concept)).sort();
      upsertEdge(edgeMap, {
        fromSeqNo: previous.seqNo,
        toSeqNo: projection.seqNo,
        reason: "adjacent",
        sharedConcepts: sharedAdjacentConcepts,
        weight: 1
      });
    }
  }
  const concepts = [...conceptStats.values()].sort((left, right) => {
    if (right.frequency !== left.frequency) {
      return right.frequency - left.frequency;
    }
    return left.concept.localeCompare(right.concept);
  });
  const sortedEdges = [...edgeMap.values()].sort((left, right) => {
    if (left.toSeqNo !== right.toSeqNo) {
      return left.toSeqNo - right.toSeqNo;
    }
    return left.fromSeqNo - right.fromSeqNo;
  });
  return {
    events: projections,
    concepts,
    edges: sortedEdges
  };
}
function computeDefaultQuery(stream) {
  const phase = typeof stream.current_state.phase === "string" ? stream.current_state.phase : "";
  const lastError = typeof stream.last_error === "string" ? stream.last_error : "";
  const status = stream.status;
  return [stream.workflow_type, status, phase, lastError].filter(Boolean).join(" ");
}
function rankMemoryCandidates(graph, queryTokens, limit) {
  const conceptFrequency = new Map(graph.concepts.map((node) => [node.concept, node.frequency]));
  const maxSeqNo = graph.events.length > 0 ? graph.events[graph.events.length - 1].seqNo : 0;
  const scored = graph.events.map((eventProjection) => {
    const overlapConcepts = eventProjection.concepts.filter((concept) => queryTokens.includes(concept)).sort();
    const overlapCount = overlapConcepts.length;
    const specificityScore = overlapConcepts.reduce((sum, concept) => sum + 1 / (conceptFrequency.get(concept) || 1), 0);
    const recencyDistance = maxSeqNo > 0 ? maxSeqNo - eventProjection.seqNo : 0;
    const recencyScore = 1 / (1 + recencyDistance);
    const score = overlapCount * 3 + specificityScore + recencyScore;
    return {
      seqNo: eventProjection.seqNo,
      eventType: eventProjection.eventType,
      concepts: eventProjection.concepts,
      overlapConcepts,
      score,
      excerpt: eventProjection.excerpt
    };
  });
  const hasOverlap = scored.some((item) => item.overlapConcepts.length > 0);
  const filtered = hasOverlap ? scored.filter((item) => item.overlapConcepts.length > 0) : scored;
  return filtered.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.seqNo - left.seqNo;
  }).slice(0, limit);
}
function collectThreadEdges(graph, memoryItems) {
  const focusSeqs = new Set(memoryItems.map((item) => item.seqNo));
  return graph.edges.filter((edge) => focusSeqs.has(edge.fromSeqNo) || focusSeqs.has(edge.toSeqNo)).slice(0, 16);
}
function retrieveAutonomyMemory(input) {
  const graph = buildConceptThreadGraph(input.events);
  const query = (input.query || computeDefaultQuery(input.stream)).trim();
  const queryTokens = extractConceptTokens(query, 12);
  const limit = Math.max(1, Math.min(input.limit || 5, 20));
  const items = rankMemoryCandidates(graph, queryTokens, limit);
  const threadEdges = collectThreadEdges(graph, items);
  return {
    query,
    queryTokens,
    graph: {
      eventCount: graph.events.length,
      conceptCount: graph.concepts.length,
      edgeCount: graph.edges.length,
      topConcepts: graph.concepts.slice(0, 8).map((node) => node.concept)
    },
    items,
    threadEdges
  };
}

// src/phases.ts
var AUTONOMY_WORKFLOW_PHASES = {
  provisioning: ["pending", "creating", "installing", "ready"],
  factory: ["queued", "research", "plan", "implement", "critique", "completed"]
};
function defaultPhaseForWorkflow(workflowType) {
  return AUTONOMY_WORKFLOW_PHASES[workflowType][0];
}
function terminalPhaseForWorkflow(workflowType) {
  const phases = AUTONOMY_WORKFLOW_PHASES[workflowType];
  return phases[phases.length - 1];
}
function isTerminalPhase(workflowType, phase) {
  return phase === terminalPhaseForWorkflow(workflowType);
}
function nextPhaseForWorkflow(workflowType, phase) {
  const phases = AUTONOMY_WORKFLOW_PHASES[workflowType];
  const idx = phases.indexOf(phase);
  if (idx === -1 || idx >= phases.length - 1) {
    return null;
  }
  return phases[idx + 1];
}

// src/policy-guard.ts
var SYSTEM_ONLY_EVENT_TYPES = /* @__PURE__ */ new Set([
  "stream.started",
  "step.succeeded",
  "retry.scheduled",
  "adaptation.applied",
  "stream.completed",
  "stream.failed_terminal",
  "stream.marked_inconsistent"
]);
function evaluateAutonomyWritePolicy(input) {
  if (input.eventType === "policy.violation") {
    return { allowed: true };
  }
  if (SYSTEM_ONLY_EVENT_TYPES.has(input.eventType) && input.actorType !== "system") {
    return {
      allowed: false,
      reason: `event_type_requires_system_actor:${input.eventType}`
    };
  }
  return { allowed: true };
}

// src/reducer.ts
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function reduceAutonomyStream(stream, events, options = {}) {
  const startSeqNo = options.startSeqNo ?? 0;
  const basePhase = asString(options.seedState?.phase) || asString(stream.current_state.phase) || defaultPhaseForWorkflow(stream.workflow_type);
  let status = options.seedState?.status || stream.status;
  let phase = basePhase;
  let retryCount = options.seedState?.retryCount ?? stream.retry_count;
  let lastError = options.seedState?.lastError ?? stream.last_error;
  let lastSeqNo = options.seedState?.lastSeqNo ?? startSeqNo;
  const seenIdempotencyKeys = /* @__PURE__ */ new Set();
  if (events.length === 0) {
    return {
      streamId: stream.id,
      workflowType: stream.workflow_type,
      status,
      phase,
      retryCount,
      lastSeqNo,
      lastError,
      inconsistent: false
    };
  }
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedSeq = startSeqNo + i + 1;
    if (event.seq_no !== expectedSeq) {
      return {
        streamId: stream.id,
        workflowType: stream.workflow_type,
        status: "inconsistent",
        phase,
        retryCount,
        lastSeqNo: event.seq_no,
        lastError,
        inconsistent: true,
        reason: `sequence_gap_at_${expectedSeq}`
      };
    }
    if (seenIdempotencyKeys.has(event.idempotency_key)) {
      lastSeqNo = event.seq_no;
      continue;
    }
    seenIdempotencyKeys.add(event.idempotency_key);
    switch (event.event_type) {
      case "stream.started":
        status = "running";
        break;
      case "step.succeeded": {
        const toPhase = asString(event.payload_json.to_phase);
        if (toPhase) {
          phase = toPhase;
        }
        status = isTerminalPhase(stream.workflow_type, phase) ? "completed" : "running";
        lastError = null;
        break;
      }
      case "retry.scheduled": {
        status = "retry_scheduled";
        const retries = event.payload_json.retry_count;
        if (typeof retries === "number" && Number.isFinite(retries) && retries >= 0) {
          retryCount = retries;
        }
        const errorMessage = asString(event.payload_json.error);
        lastError = errorMessage || lastError;
        break;
      }
      case "stream.completed":
        status = "completed";
        lastError = null;
        break;
      case "stream.failed_terminal": {
        status = "failed_terminal";
        const errorMessage = asString(event.payload_json.error);
        lastError = errorMessage || lastError;
        const retries = event.payload_json.retry_count;
        if (typeof retries === "number" && Number.isFinite(retries) && retries >= 0) {
          retryCount = retries;
        }
        break;
      }
      case "stream.marked_inconsistent":
        status = "inconsistent";
        break;
      default:
        break;
    }
    lastSeqNo = event.seq_no;
  }
  return {
    streamId: stream.id,
    workflowType: stream.workflow_type,
    status,
    phase,
    retryCount,
    lastSeqNo,
    lastError,
    inconsistent: status === "inconsistent"
  };
}

// src/retry-policy.ts
function computeRetryBackoffMs(attempt) {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return 1e3;
  }
  const cappedAttempt = Math.min(attempt, 5);
  return Math.pow(2, cappedAttempt - 1) * 1e3;
}

// src/introspection.ts
var AutonomyIntrospectionService = class {
  constructor(repository) {
    this.repository = repository;
  }
  async inspectStream(streamId, options = {}) {
    const stream = await this.repository.getStream(streamId);
    if (!stream) {
      return {
        status: "unknown_stream",
        streamId,
        stream: null,
        reducedState: null,
        lastEvent: null,
        lease: null,
        snapshot: null,
        deadLetter: null,
        errorSummary: null,
        memoryContext: null
      };
    }
    const [events, lease, snapshot, deadLetter] = await Promise.all([
      this.repository.getEvents(streamId),
      this.repository.getLease(streamId),
      this.repository.getLatestSnapshot(streamId),
      this.repository.getLatestDeadLetter(streamId)
    ]);
    const reducedState = reduceAutonomyStream(stream, events);
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    const inconsistent = stream.status === "inconsistent" || reducedState.inconsistent;
    const errorSummary = stream.last_error || deadLetter?.last_error || reducedState.reason || null;
    const memoryContext = retrieveAutonomyMemory({
      stream,
      events,
      query: options.query,
      limit: 5
    });
    return {
      status: inconsistent ? "inconsistent_stream" : "ok",
      streamId,
      stream,
      reducedState,
      lastEvent,
      lease,
      snapshot,
      deadLetter,
      errorSummary,
      memoryContext
    };
  }
};

// src/lease-manager.ts
var AutonomyLeaseManager = class {
  constructor(repository) {
    this.repository = repository;
  }
  async acquireLease(input) {
    const now = input.now || /* @__PURE__ */ new Date();
    if (!await this.repository.streamExists(input.streamId)) {
      return {
        acquired: false,
        lease: null,
        reason: "stream_not_found"
      };
    }
    const leasePayload = {
      stream_id: input.streamId,
      worker_id: input.workerId,
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + input.leaseTtlMs).toISOString()
    };
    const existing = await this.repository.getLease(input.streamId);
    if (!existing) {
      try {
        const created = await this.repository.createLease(leasePayload);
        return { acquired: true, lease: created };
      } catch {
        const afterConflict = await this.repository.getLease(input.streamId);
        return {
          acquired: false,
          lease: afterConflict,
          reason: "held_by_other"
        };
      }
    }
    const isOwner = existing.worker_id === input.workerId;
    const isExpired = new Date(existing.lease_expires_at).getTime() <= now.getTime();
    if (!isOwner && !isExpired) {
      return {
        acquired: false,
        lease: existing,
        reason: "held_by_other"
      };
    }
    const updated = await this.repository.updateLeaseIfCurrentHolder(
      input.streamId,
      existing.worker_id,
      leasePayload
    );
    if (!updated) {
      const current = await this.repository.getLease(input.streamId);
      return {
        acquired: false,
        lease: current,
        reason: "held_by_other"
      };
    }
    return { acquired: true, lease: updated };
  }
  async heartbeatLease(streamId, workerId, leaseTtlMs, now = /* @__PURE__ */ new Date()) {
    const current = await this.repository.getLease(streamId);
    if (!current || current.worker_id !== workerId) {
      return null;
    }
    const nextLease = {
      stream_id: streamId,
      worker_id: workerId,
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + leaseTtlMs).toISOString()
    };
    return this.repository.updateLeaseIfCurrentHolder(streamId, workerId, nextLease);
  }
  async releaseLease(streamId, workerId) {
    return this.repository.deleteLease(streamId, workerId);
  }
};

// src/repository-types.ts
var AutonomyRepositoryError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AutonomyRepositoryError";
  }
};

// src/ledger.ts
var AutonomyPolicyViolationError = class extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
    this.name = "AutonomyPolicyViolationError";
  }
};
var AutonomyLedgerService = class {
  constructor(repository) {
    this.repository = repository;
  }
  async appendEvent(input) {
    const existing = await this.repository.getEventByIdempotencyKey(input.streamId, input.idempotencyKey);
    if (existing) {
      return { event: existing, deduplicated: true };
    }
    const policy = evaluateAutonomyWritePolicy({
      eventType: input.eventType,
      actorType: input.actorType
    });
    if (!policy.allowed) {
      await this.appendPolicyViolation(input, policy.reason || "write_denied_by_policy");
      throw new AutonomyPolicyViolationError(
        `Autonomy write denied by policy for event type ${input.eventType}`,
        policy.reason || "write_denied_by_policy"
      );
    }
    const stream = await this.repository.getStream(input.streamId);
    if (!stream) {
      throw new Error(`Autonomy stream not found: ${input.streamId}`);
    }
    const latestEvent = await this.repository.getLatestEvent(input.streamId);
    const nextSeqNo = (latestEvent?.seq_no ?? stream.last_seq_no) + 1;
    const createdAt = input.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    const toHash = {
      stream_id: input.streamId,
      seq_no: nextSeqNo,
      event_type: input.eventType,
      payload_json: input.payload || {},
      metadata_json: input.metadata || {},
      idempotency_key: input.idempotencyKey,
      prev_hash: latestEvent?.event_hash || null,
      actor_type: input.actorType || null,
      actor_id: input.actorId || null,
      created_at: createdAt
    };
    const newEvent = {
      ...toHash,
      event_hash: computeAutonomyEventHash(toHash)
    };
    try {
      const inserted = await this.repository.insertEvent(newEvent);
      await this.repository.advanceStreamSequence(input.streamId, inserted.seq_no);
      return { event: inserted, deduplicated: false };
    } catch (error) {
      if (error instanceof AutonomyRepositoryError && error.code === "conflict") {
        const deduplicated = await this.repository.getEventByIdempotencyKey(input.streamId, input.idempotencyKey);
        if (deduplicated) {
          return { event: deduplicated, deduplicated: true };
        }
      }
      throw error;
    }
  }
  async appendPolicyViolation(input, reason) {
    const stream = await this.repository.getStream(input.streamId);
    if (!stream) {
      return;
    }
    const latestEvent = await this.repository.getLatestEvent(input.streamId);
    const nextSeqNo = (latestEvent?.seq_no ?? stream.last_seq_no) + 1;
    const createdAt = input.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    const violationPayload = {
      denied_event_type: input.eventType,
      denied_actor_type: input.actorType || null,
      reason
    };
    const violationMeta = {
      source: "autonomy_policy_guard",
      denied_idempotency_key: input.idempotencyKey
    };
    const idempotencyKey = `policy-violation:${input.idempotencyKey}`;
    const toHash = {
      stream_id: input.streamId,
      seq_no: nextSeqNo,
      event_type: "policy.violation",
      payload_json: violationPayload,
      metadata_json: violationMeta,
      idempotency_key: idempotencyKey,
      prev_hash: latestEvent?.event_hash || null,
      actor_type: "system",
      actor_id: "autonomy-policy-guard",
      created_at: createdAt
    };
    const newEvent = {
      ...toHash,
      event_hash: computeAutonomyEventHash(toHash)
    };
    try {
      const inserted = await this.repository.insertEvent(newEvent);
      await this.repository.advanceStreamSequence(input.streamId, inserted.seq_no);
    } catch (error) {
      if (error instanceof AutonomyRepositoryError && error.code === "conflict") {
        return;
      }
      throw error;
    }
  }
};

// src/slot-supervisor.ts
import { createHash as createHash2 } from "crypto";
function normalizeEpoch(epochIso) {
  if (!epochIso) {
    return "2026-01-01T00:00:00.000Z";
  }
  const value = new Date(epochIso);
  if (Number.isNaN(value.getTime())) {
    return "2026-01-01T00:00:00.000Z";
  }
  return value.toISOString();
}
function normalizeIntervalSeconds(intervalSeconds) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return 60;
  }
  return Math.max(5, Math.floor(intervalSeconds));
}
function computeAutonomySlot(now, options = {}) {
  const epochIso = normalizeEpoch(options.epochIso);
  const intervalSeconds = normalizeIntervalSeconds(options.intervalSeconds);
  const epochMs = new Date(epochIso).getTime();
  const intervalMs = intervalSeconds * 1e3;
  const delta = Math.max(0, now.getTime() - epochMs);
  const slotNumber = Math.floor(delta / intervalMs);
  const slotStartMs = epochMs + slotNumber * intervalMs;
  const slotEndMs = slotStartMs + intervalMs;
  const slotId = createHash2("sha256").update(`${epochIso}|${intervalSeconds}|${slotNumber}`).digest("hex").slice(0, 24);
  return {
    epochIso,
    intervalSeconds,
    slotNumber,
    slotId,
    slotStartedAt: new Date(slotStartMs).toISOString(),
    slotEndsAt: new Date(slotEndMs).toISOString(),
    driftMs: now.getTime() - slotStartMs
  };
}

// src/tick-engine.ts
import { randomUUID } from "crypto";
function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
async function withTimeout(promise, timeoutMs, timeoutErrorMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutErrorMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
function computeDurationMs(startedAt) {
  return Date.now() - startedAt;
}
var AutonomyTickEngine = class {
  constructor(options) {
    this.options = options;
    this.workerId = options.workerId || `worker-${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 3e4;
    this.tickBudgetMs = options.tickBudgetMs ?? 3e4;
    this.tickDelayMs = options.tickDelayMs ?? 5e3;
    this.snapshotInterval = Math.max(1, options.snapshotInterval ?? 25);
    this.maxAdaptationAttempts = Math.max(1, options.maxAdaptationAttempts ?? 3);
    this.transitionExecutor = options.transitionExecutor || (() => {
    });
    this.clock = options.clock || (() => /* @__PURE__ */ new Date());
  }
  async processRunnableStreams(input = {}) {
    const now = input.now || this.clock();
    const startedAt = now.toISOString();
    const limit = input.limit ?? 10;
    const streams = await this.options.repository.listRunnableStreams(now, limit);
    const results = [];
    const slotId = input.slotId;
    for (const stream of streams) {
      const result = await this.runTick({
        streamId: stream.id,
        tickId: slotId ? `slot:${slotId}:stream:${stream.id}` : `loop:${this.workerId}:${stream.id}:${randomUUID()}`,
        now
      });
      results.push(result);
    }
    return {
      workerId: this.workerId,
      startedAt,
      slotId,
      attempted: streams.length,
      processed: results.filter(
        (result) => result.outcome === "processed" || result.outcome === "completed" || result.outcome === "retry_scheduled" || result.outcome === "failed_terminal"
      ).length,
      results
    };
  }
  async runTick(input) {
    const startedAtMs = Date.now();
    const tickId = input.tickId || `tick:${randomUUID()}`;
    const now = input.now || this.clock();
    const stream = await this.options.repository.getStream(input.streamId);
    if (!stream) {
      return {
        streamId: input.streamId,
        tickId,
        outcome: "not_found",
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    const lastTickId = typeof stream.current_state.last_tick_id === "string" ? stream.current_state.last_tick_id : null;
    if (lastTickId === tickId) {
      return {
        streamId: stream.id,
        tickId,
        outcome: "already_processed",
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    if (stream.next_tick_at && new Date(stream.next_tick_at).getTime() > now.getTime()) {
      return {
        streamId: stream.id,
        tickId,
        outcome: "not_runnable",
        reason: `scheduled_for_${stream.next_tick_at}`,
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    const lease = await this.options.leaseManager.acquireLease({
      streamId: stream.id,
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
      now
    });
    if (!lease.acquired) {
      return {
        streamId: stream.id,
        tickId,
        outcome: "lease_not_acquired",
        reason: lease.reason,
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    try {
      return await this.runTickWithLease(stream.id, tickId, now, startedAtMs);
    } finally {
      await this.options.leaseManager.releaseLease(stream.id, this.workerId);
    }
  }
  async runTickWithLease(streamId, tickId, now, startedAtMs) {
    const stream = await this.options.repository.getStream(streamId);
    if (!stream) {
      return {
        streamId,
        tickId,
        outcome: "not_found",
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    const snapshot = await this.options.repository.getLatestSnapshot(streamId);
    const useSnapshot = !!snapshot && snapshot.last_seq_no > 0 && snapshot.last_seq_no <= stream.last_seq_no;
    const events = useSnapshot ? await this.options.repository.getEventsAfterSequence(streamId, snapshot.last_seq_no) : await this.options.repository.getEvents(streamId);
    const reduced = reduceAutonomyStream(
      stream,
      events,
      useSnapshot ? {
        startSeqNo: snapshot.last_seq_no,
        seedState: {
          status: snapshot.state_blob.status,
          phase: snapshot.state_blob.phase,
          retryCount: snapshot.state_blob.retry_count,
          lastError: snapshot.state_blob.last_error,
          lastSeqNo: snapshot.last_seq_no
        }
      } : void 0
    );
    const phase = reduced.phase;
    if (reduced.inconsistent) {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: "stream.marked_inconsistent",
        payload: { reason: reduced.reason || "inconsistent_stream", tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:inconsistent`,
        actorType: "system",
        actorId: this.workerId,
        createdAt: now.toISOString()
      });
      await this.options.repository.updateStream(streamId, {
        status: "inconsistent",
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId,
          inconsistent_reason: reduced.reason || "inconsistent_stream"
        },
        next_tick_at: null,
        last_error: reduced.reason || "inconsistent_stream"
      });
      await this.maybePersistSnapshot(streamId, true);
      return {
        streamId,
        tickId,
        outcome: "inconsistent_stream",
        reason: reduced.reason || "inconsistent_stream",
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    if (reduced.status === "completed" || reduced.status === "failed_terminal" || reduced.status === "inconsistent") {
      return {
        streamId,
        tickId,
        outcome: "not_runnable",
        reason: `terminal_status_${reduced.status}`,
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    if (isTerminalPhase(stream.workflow_type, phase)) {
      await this.options.repository.updateStream(streamId, {
        status: "completed",
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId
        },
        retry_count: 0,
        next_tick_at: null,
        last_error: null
      });
      await this.maybePersistSnapshot(streamId, true);
      return {
        streamId,
        tickId,
        outcome: "completed",
        reason: "already_at_terminal_phase",
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    if (reduced.status === "pending") {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: "stream.started",
        payload: { phase, tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:start`,
        actorType: "system",
        actorId: this.workerId,
        createdAt: now.toISOString()
      });
      await this.options.repository.updateStream(streamId, {
        status: "running",
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId
        },
        last_error: null,
        next_tick_at: new Date(now.getTime() + this.tickDelayMs).toISOString()
      });
      await this.maybePersistSnapshot(streamId);
      return {
        streamId,
        tickId,
        outcome: "processed",
        eventType: "stream.started",
        nextTickAt: new Date(now.getTime() + this.tickDelayMs).toISOString(),
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    const toPhase = nextPhaseForWorkflow(stream.workflow_type, phase);
    if (!toPhase) {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: "stream.marked_inconsistent",
        payload: { reason: `phase_transition_missing:${phase}`, tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:phase-missing`,
        actorType: "system",
        actorId: this.workerId,
        createdAt: now.toISOString()
      });
      await this.options.repository.updateStream(streamId, {
        status: "inconsistent",
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId,
          inconsistent_reason: `phase_transition_missing:${phase}`
        },
        next_tick_at: null,
        last_error: `phase_transition_missing:${phase}`
      });
      await this.maybePersistSnapshot(streamId, true);
      return {
        streamId,
        tickId,
        outcome: "inconsistent_stream",
        reason: `phase_transition_missing:${phase}`,
        durationMs: computeDurationMs(startedAtMs)
      };
    }
    try {
      const memoryContext = retrieveAutonomyMemory({
        stream,
        events,
        query: `${stream.workflow_type} ${phase} ${toPhase} ${stream.last_error || ""}`.trim(),
        limit: 5
      });
      await withTimeout(
        Promise.resolve(
          this.transitionExecutor({
            stream,
            fromPhase: phase,
            toPhase,
            tickId,
            now,
            memoryContext
          })
        ),
        this.tickBudgetMs,
        "tick_budget_exceeded"
      );
      await this.options.ledger.appendEvent({
        streamId,
        eventType: "step.succeeded",
        payload: { from_phase: phase, to_phase: toPhase, tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:step:${phase}:${toPhase}`,
        actorType: "system",
        actorId: this.workerId,
        createdAt: now.toISOString()
      });
      const completed = isTerminalPhase(stream.workflow_type, toPhase);
      const nextTickAt = completed ? null : new Date(now.getTime() + this.tickDelayMs).toISOString();
      await this.options.repository.updateStream(streamId, {
        status: completed ? "completed" : "running",
        current_state: {
          ...stream.current_state,
          phase: toPhase,
          last_tick_id: tickId
        },
        retry_count: 0,
        next_tick_at: nextTickAt,
        last_error: null
      });
      await this.maybePersistSnapshot(streamId, completed);
      return {
        streamId,
        tickId,
        outcome: completed ? "completed" : "processed",
        eventType: "step.succeeded",
        nextTickAt,
        retryCount: 0,
        durationMs: computeDurationMs(startedAtMs)
      };
    } catch (error) {
      return this.handleTransitionFailure({
        stream,
        events,
        phase,
        tickId,
        now,
        error,
        startedAtMs
      });
    }
  }
  async handleTransitionFailure(input) {
    const errorMessage = getErrorMessage(input.error);
    const attempt = input.stream.retry_count + 1;
    const streamId = input.stream.id;
    const adaptation = computeBoundedAdaptationDecision({
      events: input.events,
      errorMessage,
      maxAttempts: this.maxAdaptationAttempts
    });
    if (adaptation.applied && adaptation.policyId) {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: "adaptation.applied",
        payload: {
          attempt: adaptation.attempt,
          max_attempts: adaptation.maxAttempts,
          policy_id: adaptation.policyId,
          error_digest: adaptation.errorDigest,
          tick_id: input.tickId
        },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${input.tickId}:adapt:${adaptation.attempt}`,
        actorType: "system",
        actorId: this.workerId,
        createdAt: input.now.toISOString()
      });
    }
    const baseState = {
      ...input.stream.current_state,
      phase: input.phase,
      last_tick_id: input.tickId,
      adaptation: {
        attempts_applied: adaptation.applied ? adaptation.attempt : adaptation.priorAttempts,
        max_attempts: adaptation.maxAttempts,
        last_policy_id: adaptation.policyId,
        exhausted: adaptation.exhausted,
        last_error_digest: adaptation.errorDigest,
        updated_at: input.now.toISOString()
      }
    };
    if (attempt > input.stream.max_retries) {
      const failedEvent = await this.options.ledger.appendEvent({
        streamId,
        eventType: "stream.failed_terminal",
        payload: {
          error: errorMessage,
          retry_count: attempt,
          terminal_reason: "max_retries_exceeded",
          tick_id: input.tickId
        },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${input.tickId}:failed_terminal:${attempt}`,
        actorType: "system",
        actorId: this.workerId,
        createdAt: input.now.toISOString()
      });
      await this.options.repository.updateStream(streamId, {
        status: "failed_terminal",
        current_state: baseState,
        retry_count: attempt,
        next_tick_at: null,
        last_error: errorMessage
      });
      await this.maybePersistSnapshot(streamId, true);
      await this.options.repository.insertDeadLetter({
        stream_id: streamId,
        terminal_reason: "max_retries_exceeded",
        attempts: attempt,
        last_error: errorMessage,
        last_event_id: failedEvent.event.id
      });
      return {
        streamId,
        tickId: input.tickId,
        outcome: "failed_terminal",
        eventType: "stream.failed_terminal",
        retryCount: attempt,
        reason: errorMessage,
        durationMs: computeDurationMs(input.startedAtMs)
      };
    }
    const backoffMs = computeRetryBackoffMs(attempt);
    const nextTickAt = new Date(input.now.getTime() + backoffMs).toISOString();
    await this.options.ledger.appendEvent({
      streamId,
      eventType: "retry.scheduled",
      payload: {
        error: errorMessage,
        retry_count: attempt,
        backoff_ms: backoffMs,
        tick_id: input.tickId
      },
      metadata: { worker_id: this.workerId },
      idempotencyKey: `${input.tickId}:retry:${attempt}`,
      actorType: "system",
      actorId: this.workerId,
      createdAt: input.now.toISOString()
    });
    await this.options.repository.updateStream(streamId, {
      status: "retry_scheduled",
      current_state: baseState,
      retry_count: attempt,
      next_tick_at: nextTickAt,
      last_error: errorMessage
    });
    await this.maybePersistSnapshot(streamId);
    return {
      streamId,
      tickId: input.tickId,
      outcome: "retry_scheduled",
      eventType: "retry.scheduled",
      retryCount: attempt,
      nextTickAt,
      reason: errorMessage,
      durationMs: computeDurationMs(input.startedAtMs)
    };
  }
  async maybePersistSnapshot(streamId, force = false) {
    const stream = await this.options.repository.getStream(streamId);
    if (!stream || stream.last_seq_no <= 0) {
      return;
    }
    if (!force && stream.last_seq_no % this.snapshotInterval !== 0) {
      return;
    }
    const phase = typeof stream.current_state.phase === "string" && stream.current_state.phase.length > 0 ? stream.current_state.phase : defaultPhaseForWorkflow(stream.workflow_type);
    const stateBlob = {
      status: stream.status,
      phase,
      retry_count: stream.retry_count,
      last_error: stream.last_error,
      workflow_type: stream.workflow_type
    };
    const stateHash = computeAutonomyDigest({
      stream_id: stream.id,
      last_seq_no: stream.last_seq_no,
      state_blob: stateBlob
    });
    await this.options.repository.upsertSnapshot({
      stream_id: stream.id,
      last_seq_no: stream.last_seq_no,
      state_blob: stateBlob,
      state_hash: stateHash
    });
  }
};

// src/in-memory-repository.ts
import { randomUUID as randomUUID2 } from "crypto";
var InMemoryAutonomyRepository = class {
  constructor() {
    this.streams = /* @__PURE__ */ new Map();
    this.eventsByStream = /* @__PURE__ */ new Map();
    this.leases = /* @__PURE__ */ new Map();
    this.deadLettersByStream = /* @__PURE__ */ new Map();
    this.snapshotsByStream = /* @__PURE__ */ new Map();
  }
  createStream(stream) {
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const row = {
      id: stream.id,
      workflow_type: stream.workflow_type,
      owner_user_id: stream.owner_user_id,
      status: stream.status || "pending",
      current_state: stream.current_state || {},
      last_seq_no: stream.last_seq_no || 0,
      retry_count: stream.retry_count || 0,
      max_retries: stream.max_retries || 5,
      next_tick_at: stream.next_tick_at || nowIso,
      last_error: stream.last_error || null,
      created_at: stream.created_at || nowIso,
      updated_at: stream.updated_at || nowIso
    };
    this.streams.set(row.id, row);
    return { ...row };
  }
  async streamExists(streamId) {
    return this.streams.has(streamId);
  }
  async getStream(streamId) {
    const stream = this.streams.get(streamId);
    return stream ? { ...stream, current_state: { ...stream.current_state } } : null;
  }
  async updateStream(streamId, changes) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return null;
    }
    const updated = {
      ...stream,
      ...changes,
      current_state: changes.current_state ? { ...changes.current_state } : stream.current_state,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.streams.set(streamId, updated);
    return { ...updated, current_state: { ...updated.current_state } };
  }
  async listRunnableStreams(now, limit) {
    return [...this.streams.values()].filter((stream) => {
      if (!stream.next_tick_at) {
        return false;
      }
      const runnableStatus = stream.status === "pending" || stream.status === "running" || stream.status === "retry_scheduled";
      return runnableStatus && new Date(stream.next_tick_at).getTime() <= now.getTime();
    }).sort((a, b) => {
      const aTick = a.next_tick_at ? new Date(a.next_tick_at).getTime() : 0;
      const bTick = b.next_tick_at ? new Date(b.next_tick_at).getTime() : 0;
      return aTick - bTick;
    }).slice(0, limit).map((stream) => ({ ...stream, current_state: { ...stream.current_state } }));
  }
  async getEvents(streamId) {
    return (this.eventsByStream.get(streamId) || []).map((event) => ({ ...event }));
  }
  async getEventsAfterSequence(streamId, afterSeqNo) {
    return (this.eventsByStream.get(streamId) || []).filter((event) => event.seq_no > afterSeqNo).map((event) => ({ ...event }));
  }
  async getLatestEvent(streamId) {
    const events = this.eventsByStream.get(streamId);
    if (!events || events.length === 0) {
      return null;
    }
    return { ...events[events.length - 1] };
  }
  async getEventByIdempotencyKey(streamId, idempotencyKey) {
    const events = this.eventsByStream.get(streamId) || [];
    const found = events.find((event) => event.idempotency_key === idempotencyKey);
    return found ? { ...found } : null;
  }
  async insertEvent(event) {
    const events = this.eventsByStream.get(event.stream_id) || [];
    const duplicateSeq = events.some((existing) => existing.seq_no === event.seq_no);
    const duplicateKey = events.some((existing) => existing.idempotency_key === event.idempotency_key);
    if (duplicateSeq || duplicateKey) {
      throw new AutonomyRepositoryError("Duplicate event", "conflict", {
        streamId: event.stream_id,
        seqNo: event.seq_no,
        idempotencyKey: event.idempotency_key
      });
    }
    const inserted = {
      id: randomUUID2(),
      ...event
    };
    this.eventsByStream.set(event.stream_id, [...events, inserted]);
    return { ...inserted };
  }
  async advanceStreamSequence(streamId, nextSeqNo) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new AutonomyRepositoryError("Stream not found", "not_found", { streamId });
    }
    if (nextSeqNo > stream.last_seq_no) {
      stream.last_seq_no = nextSeqNo;
      stream.updated_at = (/* @__PURE__ */ new Date()).toISOString();
      this.streams.set(streamId, stream);
    }
  }
  async getLease(streamId) {
    const lease = this.leases.get(streamId);
    return lease ? { ...lease } : null;
  }
  async createLease(lease) {
    if (this.leases.has(lease.stream_id)) {
      throw new AutonomyRepositoryError("Lease already exists", "conflict", { streamId: lease.stream_id });
    }
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const inserted = {
      ...lease,
      created_at: nowIso,
      updated_at: nowIso
    };
    this.leases.set(lease.stream_id, inserted);
    return { ...inserted };
  }
  async updateLeaseIfCurrentHolder(streamId, expectedWorkerId, nextLease) {
    const current = this.leases.get(streamId);
    if (!current || current.worker_id !== expectedWorkerId) {
      return null;
    }
    const updated = {
      ...current,
      worker_id: nextLease.worker_id,
      lease_expires_at: nextLease.lease_expires_at,
      heartbeat_at: nextLease.heartbeat_at,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.leases.set(streamId, updated);
    return { ...updated };
  }
  async deleteLease(streamId, workerId) {
    const current = this.leases.get(streamId);
    if (!current || current.worker_id !== workerId) {
      return false;
    }
    this.leases.delete(streamId);
    return true;
  }
  async insertDeadLetter(record) {
    const existing = this.deadLettersByStream.get(record.stream_id) || [];
    const inserted = {
      id: randomUUID2(),
      stream_id: record.stream_id,
      terminal_reason: record.terminal_reason,
      attempts: record.attempts,
      last_error: record.last_error || null,
      last_event_id: record.last_event_id || null,
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.deadLettersByStream.set(record.stream_id, [...existing, inserted]);
    return { ...inserted };
  }
  async getLatestDeadLetter(streamId) {
    const entries = this.deadLettersByStream.get(streamId) || [];
    if (entries.length === 0) {
      return null;
    }
    return { ...entries[entries.length - 1] };
  }
  async upsertSnapshot(snapshot) {
    const existing = this.snapshotsByStream.get(snapshot.stream_id);
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const next = {
      id: existing?.id || randomUUID2(),
      stream_id: snapshot.stream_id,
      last_seq_no: snapshot.last_seq_no,
      state_blob: { ...snapshot.state_blob },
      state_hash: snapshot.state_hash,
      created_at: existing?.created_at || nowIso,
      updated_at: nowIso
    };
    this.snapshotsByStream.set(snapshot.stream_id, next);
    return {
      ...next,
      state_blob: { ...next.state_blob }
    };
  }
  async getLatestSnapshot(streamId) {
    const snapshot = this.snapshotsByStream.get(streamId);
    if (!snapshot) {
      return null;
    }
    return {
      ...snapshot,
      state_blob: { ...snapshot.state_blob }
    };
  }
};

// src/repository.ts
function isUniqueViolation(code) {
  return typeof code === "string" && code === "23505";
}
function normalizeRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function toAutonomyEvent(row) {
  const record = normalizeRecord(row);
  return {
    id: String(record.id),
    stream_id: String(record.stream_id),
    seq_no: Number(record.seq_no),
    event_type: String(record.event_type),
    payload_json: normalizeRecord(record.payload_json),
    metadata_json: normalizeRecord(record.metadata_json),
    idempotency_key: String(record.idempotency_key),
    prev_hash: record.prev_hash ? String(record.prev_hash) : null,
    event_hash: String(record.event_hash),
    actor_type: record.actor_type ? String(record.actor_type) : null,
    actor_id: record.actor_id ? String(record.actor_id) : null,
    created_at: String(record.created_at)
  };
}
function toAutonomyStream(row) {
  const record = normalizeRecord(row);
  return {
    id: String(record.id),
    workflow_type: record.workflow_type || "factory",
    owner_user_id: String(record.owner_user_id),
    status: record.status || "pending",
    current_state: normalizeRecord(record.current_state),
    last_seq_no: Number(record.last_seq_no || 0),
    retry_count: Number(record.retry_count || 0),
    max_retries: Number(record.max_retries || 0),
    next_tick_at: record.next_tick_at ? String(record.next_tick_at) : null,
    last_error: record.last_error ? String(record.last_error) : null,
    created_at: String(record.created_at),
    updated_at: String(record.updated_at)
  };
}
function toAutonomyLease(row) {
  const record = normalizeRecord(row);
  return {
    stream_id: String(record.stream_id),
    worker_id: String(record.worker_id),
    lease_expires_at: String(record.lease_expires_at),
    heartbeat_at: String(record.heartbeat_at),
    created_at: String(record.created_at),
    updated_at: String(record.updated_at)
  };
}
function toAutonomyDeadLetter(row) {
  const record = normalizeRecord(row);
  return {
    id: String(record.id),
    stream_id: String(record.stream_id),
    terminal_reason: String(record.terminal_reason),
    attempts: Number(record.attempts || 0),
    last_error: record.last_error ? String(record.last_error) : null,
    last_event_id: record.last_event_id ? String(record.last_event_id) : null,
    created_at: String(record.created_at)
  };
}
function toAutonomySnapshotState(row) {
  const record = normalizeRecord(row);
  return {
    status: record.status || "pending",
    phase: String(record.phase || ""),
    retry_count: Number(record.retry_count || 0),
    last_error: record.last_error ? String(record.last_error) : null,
    workflow_type: record.workflow_type || "factory"
  };
}
function toAutonomySnapshot(row) {
  const record = normalizeRecord(row);
  return {
    id: String(record.id),
    stream_id: String(record.stream_id),
    last_seq_no: Number(record.last_seq_no || 0),
    state_blob: toAutonomySnapshotState(record.state_blob),
    state_hash: String(record.state_hash || ""),
    created_at: String(record.created_at),
    updated_at: String(record.updated_at)
  };
}
var SupabaseAutonomyRepository = class {
  constructor(client) {
    this.client = client;
  }
  async streamExists(streamId) {
    const { data, error } = await this.client.from("autonomy_streams").select("id").eq("id", streamId).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to check stream existence", "database_error", {
        streamId,
        error
      });
    }
    return !!data;
  }
  async getStream(streamId) {
    const { data, error } = await this.client.from("autonomy_streams").select("*").eq("id", streamId).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch autonomy stream", "database_error", {
        streamId,
        error
      });
    }
    return data ? toAutonomyStream(data) : null;
  }
  async updateStream(streamId, changes) {
    const payload = { ...changes, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
    const { data, error } = await this.client.from("autonomy_streams").update(payload).eq("id", streamId).select("*").maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to update autonomy stream", "database_error", {
        streamId,
        changes,
        error
      });
    }
    return data ? toAutonomyStream(data) : null;
  }
  async listRunnableStreams(now, limit) {
    const iso = now.toISOString();
    const { data, error } = await this.client.from("autonomy_streams").select("*").in("status", ["pending", "running", "retry_scheduled"]).lte("next_tick_at", iso).order("next_tick_at", { ascending: true }).limit(limit);
    if (error) {
      throw new AutonomyRepositoryError("Failed to list runnable autonomy streams", "database_error", {
        now: iso,
        limit,
        error
      });
    }
    return (Array.isArray(data) ? data : []).map(toAutonomyStream);
  }
  async getEvents(streamId) {
    const { data, error } = await this.client.from("autonomy_events").select("*").eq("stream_id", streamId).order("seq_no", { ascending: true });
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch autonomy events", "database_error", {
        streamId,
        error
      });
    }
    return (Array.isArray(data) ? data : []).map(toAutonomyEvent);
  }
  async getEventsAfterSequence(streamId, afterSeqNo) {
    const { data, error } = await this.client.from("autonomy_events").select("*").eq("stream_id", streamId).gt("seq_no", afterSeqNo).order("seq_no", { ascending: true });
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch autonomy events after sequence", "database_error", {
        streamId,
        afterSeqNo,
        error
      });
    }
    return (Array.isArray(data) ? data : []).map(toAutonomyEvent);
  }
  async getLatestEvent(streamId) {
    const { data, error } = await this.client.from("autonomy_events").select("*").eq("stream_id", streamId).order("seq_no", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch latest autonomy event", "database_error", {
        streamId,
        error
      });
    }
    return data ? toAutonomyEvent(data) : null;
  }
  async getEventByIdempotencyKey(streamId, idempotencyKey) {
    const { data, error } = await this.client.from("autonomy_events").select("*").eq("stream_id", streamId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch autonomy event by idempotency key", "database_error", {
        streamId,
        idempotencyKey,
        error
      });
    }
    return data ? toAutonomyEvent(data) : null;
  }
  async insertEvent(event) {
    const { data, error } = await this.client.from("autonomy_events").insert([event]).select("*").single();
    if (error) {
      if (isUniqueViolation(error.code)) {
        throw new AutonomyRepositoryError("Autonomy event insert conflict", "conflict", {
          streamId: event.stream_id,
          idempotencyKey: event.idempotency_key,
          seqNo: event.seq_no,
          error
        });
      }
      throw new AutonomyRepositoryError("Failed to insert autonomy event", "database_error", {
        streamId: event.stream_id,
        idempotencyKey: event.idempotency_key,
        seqNo: event.seq_no,
        error
      });
    }
    return toAutonomyEvent(data);
  }
  async advanceStreamSequence(streamId, nextSeqNo) {
    const { error } = await this.client.from("autonomy_streams").update({
      last_seq_no: nextSeqNo,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("id", streamId).lt("last_seq_no", nextSeqNo);
    if (error) {
      throw new AutonomyRepositoryError("Failed to advance autonomy stream sequence", "database_error", {
        streamId,
        nextSeqNo,
        error
      });
    }
  }
  async getLease(streamId) {
    const { data, error } = await this.client.from("autonomy_leases").select("*").eq("stream_id", streamId).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch autonomy lease", "database_error", {
        streamId,
        error
      });
    }
    return data ? toAutonomyLease(data) : null;
  }
  async createLease(lease) {
    const { data, error } = await this.client.from("autonomy_leases").insert([lease]).select("*").single();
    if (error) {
      if (isUniqueViolation(error.code)) {
        throw new AutonomyRepositoryError("Autonomy lease conflict", "conflict", {
          streamId: lease.stream_id,
          workerId: lease.worker_id,
          error
        });
      }
      throw new AutonomyRepositoryError("Failed to create autonomy lease", "database_error", {
        streamId: lease.stream_id,
        workerId: lease.worker_id,
        error
      });
    }
    return toAutonomyLease(data);
  }
  async updateLeaseIfCurrentHolder(streamId, expectedWorkerId, nextLease) {
    const { data, error } = await this.client.from("autonomy_leases").update({
      worker_id: nextLease.worker_id,
      lease_expires_at: nextLease.lease_expires_at,
      heartbeat_at: nextLease.heartbeat_at,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("stream_id", streamId).eq("worker_id", expectedWorkerId).select("*").maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to update autonomy lease", "database_error", {
        streamId,
        expectedWorkerId,
        nextWorkerId: nextLease.worker_id,
        error
      });
    }
    return data ? toAutonomyLease(data) : null;
  }
  async deleteLease(streamId, workerId) {
    const { error } = await this.client.from("autonomy_leases").delete().eq("stream_id", streamId).eq("worker_id", workerId);
    if (error) {
      throw new AutonomyRepositoryError("Failed to delete autonomy lease", "database_error", {
        streamId,
        workerId,
        error
      });
    }
    return true;
  }
  async insertDeadLetter(record) {
    const { data, error } = await this.client.from("autonomy_dead_letters").insert([{
      stream_id: record.stream_id,
      terminal_reason: record.terminal_reason,
      attempts: record.attempts,
      last_error: record.last_error || null,
      last_event_id: record.last_event_id || null
    }]).select("*").single();
    if (error) {
      throw new AutonomyRepositoryError("Failed to insert autonomy dead letter", "database_error", {
        streamId: record.stream_id,
        error
      });
    }
    return toAutonomyDeadLetter(data);
  }
  async getLatestDeadLetter(streamId) {
    const { data, error } = await this.client.from("autonomy_dead_letters").select("*").eq("stream_id", streamId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch latest autonomy dead letter", "database_error", {
        streamId,
        error
      });
    }
    return data ? toAutonomyDeadLetter(data) : null;
  }
  async upsertSnapshot(snapshot) {
    const { data, error } = await this.client.from("autonomy_snapshots").upsert([{
      stream_id: snapshot.stream_id,
      last_seq_no: snapshot.last_seq_no,
      state_blob: snapshot.state_blob,
      state_hash: snapshot.state_hash
    }], {
      onConflict: "stream_id",
      ignoreDuplicates: false
    }).select("*").single();
    if (error) {
      throw new AutonomyRepositoryError("Failed to upsert autonomy snapshot", "database_error", {
        streamId: snapshot.stream_id,
        lastSeqNo: snapshot.last_seq_no,
        error
      });
    }
    return toAutonomySnapshot(data);
  }
  async getLatestSnapshot(streamId) {
    const { data, error } = await this.client.from("autonomy_snapshots").select("*").eq("stream_id", streamId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      throw new AutonomyRepositoryError("Failed to fetch autonomy snapshot", "database_error", {
        streamId,
        error
      });
    }
    return data ? toAutonomySnapshot(data) : null;
  }
};

// src/proof/receipt.ts
import { createHmac } from "crypto";
var RECEIPT_SCHEMA_VERSION = "1.0.0";
var DEFAULT_ENGINE_VERSION = "dak-core@0.1.0";
function digestPolicyEvents(events) {
  const policyEvents = events.filter(
    (event) => event.event_type === "policy.violation" || event.event_type === "adaptation.applied" || event.event_type === "retry.scheduled" || event.event_type === "stream.failed_terminal" || event.event_type === "stream.marked_inconsistent"
  ).map((event) => ({
    seq_no: event.seq_no,
    event_type: event.event_type,
    payload_json: event.payload_json,
    metadata_json: event.metadata_json
  }));
  return computeAutonomyDigest(policyEvents);
}
function signaturePayload(receipt) {
  return JSON.stringify(receipt);
}
function signReceipt(receipt, secret) {
  if (!secret) {
    return null;
  }
  return createHmac("sha256", secret).update(signaturePayload(receipt)).digest("hex");
}
function verifyEventHashChain(events) {
  const issues = [];
  if (events.length === 0) {
    return {
      valid: true,
      issues,
      chainRoot: computeAutonomyDigest([])
    };
  }
  const sorted = [...events].sort((a, b) => a.seq_no - b.seq_no);
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    const previous = sorted[index - 1];
    const expectedHash = computeAutonomyEventHash({
      stream_id: event.stream_id,
      seq_no: event.seq_no,
      event_type: event.event_type,
      payload_json: event.payload_json,
      metadata_json: event.metadata_json,
      idempotency_key: event.idempotency_key,
      prev_hash: event.prev_hash,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      created_at: event.created_at
    });
    if (expectedHash !== event.event_hash) {
      issues.push(`event_hash_mismatch_at_seq_${event.seq_no}`);
    }
    if (index === 0) {
      if (event.prev_hash !== null) {
        issues.push(`first_event_prev_hash_not_null_at_seq_${event.seq_no}`);
      }
    } else {
      if (event.prev_hash !== previous.event_hash) {
        issues.push(`prev_hash_mismatch_at_seq_${event.seq_no}`);
      }
      if (event.seq_no !== previous.seq_no + 1) {
        issues.push(`sequence_gap_between_${previous.seq_no}_and_${event.seq_no}`);
      }
      if (event.stream_id !== previous.stream_id) {
        issues.push(`mixed_stream_ids_at_seq_${event.seq_no}`);
      }
    }
  }
  return {
    valid: issues.length === 0,
    issues,
    chainRoot: computeAutonomyDigest(sorted.map((event) => event.event_hash))
  };
}
function snapshotStateHash(snapshotState) {
  if (!snapshotState) {
    return null;
  }
  return computeAutonomyDigest(snapshotState);
}
function buildDeterminismReceipt(input) {
  const chain = verifyEventHashChain(input.events);
  const reduced = input.reducedState || reduceAutonomyStream(input.stream, input.events);
  const generatedAt = input.generatedAt || (/* @__PURE__ */ new Date()).toISOString();
  const sorted = [...input.events].sort((a, b) => a.seq_no - b.seq_no);
  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    engine_version: input.engineVersion || DEFAULT_ENGINE_VERSION,
    stream_id: input.stream.id,
    tick_id: input.tickId,
    event_count: sorted.length,
    first_seq_no: sorted.length > 0 ? sorted[0].seq_no : null,
    last_seq_no: sorted.length > 0 ? sorted[sorted.length - 1].seq_no : null,
    event_chain_root: chain.chainRoot,
    replay_state_hash: computeAutonomyDigest(reduced),
    policy_decision_hash: digestPolicyEvents(sorted),
    snapshot_state_hash: snapshotStateHash(input.snapshot?.state_blob),
    generated_at: generatedAt
  };
  return {
    ...base,
    signature: signReceipt(base, input.signingSecret)
  };
}
function verifyDeterminismReceipt(receipt, input) {
  const expected = buildDeterminismReceipt({
    ...input,
    generatedAt: receipt.generated_at,
    engineVersion: receipt.engine_version,
    signingSecret: input.signingSecret
  });
  const issues = [];
  if (expected.schema_version !== receipt.schema_version) {
    issues.push("schema_version_mismatch");
  }
  if (expected.stream_id !== receipt.stream_id) {
    issues.push("stream_id_mismatch");
  }
  if (expected.tick_id !== receipt.tick_id) {
    issues.push("tick_id_mismatch");
  }
  if (expected.event_chain_root !== receipt.event_chain_root) {
    issues.push("event_chain_root_mismatch");
  }
  if (expected.replay_state_hash !== receipt.replay_state_hash) {
    issues.push("replay_state_hash_mismatch");
  }
  if (expected.policy_decision_hash !== receipt.policy_decision_hash) {
    issues.push("policy_decision_hash_mismatch");
  }
  if (expected.snapshot_state_hash !== receipt.snapshot_state_hash) {
    issues.push("snapshot_state_hash_mismatch");
  }
  if (expected.signature !== receipt.signature) {
    issues.push("signature_mismatch");
  }
  return {
    valid: issues.length === 0,
    issues,
    expected
  };
}

export {
  computeAutonomyDigest,
  computeAutonomyEventHash,
  computeBoundedAdaptationDecision,
  extractConceptTokens,
  buildConceptThreadGraph,
  retrieveAutonomyMemory,
  AUTONOMY_WORKFLOW_PHASES,
  defaultPhaseForWorkflow,
  terminalPhaseForWorkflow,
  isTerminalPhase,
  nextPhaseForWorkflow,
  evaluateAutonomyWritePolicy,
  reduceAutonomyStream,
  computeRetryBackoffMs,
  AutonomyIntrospectionService,
  AutonomyLeaseManager,
  AutonomyRepositoryError,
  AutonomyPolicyViolationError,
  AutonomyLedgerService,
  computeAutonomySlot,
  AutonomyTickEngine,
  InMemoryAutonomyRepository,
  SupabaseAutonomyRepository,
  verifyEventHashChain,
  buildDeterminismReceipt,
  verifyDeterminismReceipt
};

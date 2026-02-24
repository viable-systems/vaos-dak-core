#!/usr/bin/env node

// src/cli.ts
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

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

// src/proof/receipt.ts
import { createHmac } from "crypto";
var RECEIPT_SCHEMA_VERSION = "1.0.0";
var DEFAULT_ENGINE_VERSION = "dak-core@0.2.0";
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

// src/cli.ts
function readBundle(filePath) {
  const raw = readFileSync(resolve(process.cwd(), filePath), "utf8");
  return JSON.parse(raw);
}
function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1];
}
function maybeWriteJson(outPath, payload) {
  if (!outPath) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(payload, null, 2)}
`);
}
function commandVerify(bundle, secret) {
  const chain = verifyEventHashChain(bundle.events);
  const response = {
    command: "verify",
    stream_id: bundle.stream.id,
    chain_valid: chain.valid,
    chain_issues: chain.issues,
    event_chain_root: chain.chainRoot
  };
  if (bundle.receipt) {
    const verification = verifyDeterminismReceipt(bundle.receipt, {
      stream: bundle.stream,
      events: bundle.events,
      tickId: bundle.receipt.tick_id,
      snapshot: bundle.snapshot,
      signingSecret: secret
    });
    response.receipt_valid = verification.valid;
    response.receipt_issues = verification.issues;
    response.expected_receipt = verification.expected;
    if (!verification.valid) {
      process.exitCode = 1;
    }
  } else if (!chain.valid) {
    process.exitCode = 1;
  }
  return response;
}
function commandReplay(bundle, secret) {
  const reducedState = reduceAutonomyStream(bundle.stream, bundle.events);
  const receipt = buildDeterminismReceipt({
    stream: bundle.stream,
    events: bundle.events,
    tickId: `replay:${bundle.stream.id}`,
    reducedState,
    snapshot: bundle.snapshot,
    signingSecret: secret
  });
  return {
    command: "replay",
    stream_id: bundle.stream.id,
    reduced_state: reducedState,
    receipt
  };
}
function commandAudit(bundle) {
  const counts = bundle.events.reduce((acc, event) => {
    acc[event.event_type] = (acc[event.event_type] || 0) + 1;
    return acc;
  }, {});
  const ordered = [...bundle.events].sort((a, b) => a.seq_no - b.seq_no);
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  return {
    command: "audit",
    stream_id: bundle.stream.id,
    total_events: bundle.events.length,
    status: bundle.stream.status,
    retry_count: bundle.stream.retry_count,
    last_error: bundle.stream.last_error,
    last_event: latest ? {
      seq_no: latest.seq_no,
      event_type: latest.event_type,
      created_at: latest.created_at
    } : null,
    event_type_counts: counts
  };
}
function main() {
  const command = process.argv[2];
  if (!command || !["verify", "replay", "audit"].includes(command)) {
    console.error("Usage: dak <verify|replay|audit> --file <ledger.json> [--out <output.json>] [--secret <hmac-secret>]");
    process.exit(1);
  }
  const file = readArg("--file");
  if (!file) {
    console.error("Missing required --file argument");
    process.exit(1);
  }
  const outPath = readArg("--out");
  const secret = readArg("--secret");
  const bundle = readBundle(file);
  if (!bundle.stream || !Array.isArray(bundle.events)) {
    console.error("Input JSON must contain { stream, events[] }");
    process.exit(1);
  }
  if (command === "verify") {
    maybeWriteJson(outPath, commandVerify(bundle, secret));
    return;
  }
  if (command === "replay") {
    maybeWriteJson(outPath, commandReplay(bundle, secret));
    return;
  }
  maybeWriteJson(outPath, commandAudit(bundle));
}
main();

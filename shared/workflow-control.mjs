import { createHash } from "node:crypto";

export const WORKFLOW_CONTROL_SCHEMA_VERSION = 1;
export const LEDGER_EVENT_SCHEMA_VERSION = 1;

export const WORKFLOW_ERROR_CODES = Object.freeze({
  INVALID_CONTRACT: "INVALID_CONTRACT",
  REVISION_IMMUTABLE: "REVISION_IMMUTABLE",
  STATE_CONFLICT: "STATE_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  TRANSITION_NOT_ALLOWED: "TRANSITION_NOT_ALLOWED",
  GATE_UNSATISFIED: "GATE_UNSATISFIED",
  HUMAN_AUTH_REQUIRED: "HUMAN_AUTH_REQUIRED",
  HUMAN_AUTH_SCOPE_MISMATCH: "HUMAN_AUTH_SCOPE_MISMATCH",
  AUTHORIZATION_REVOKED: "AUTHORIZATION_REVOKED",
  AGENT_EFFECT_FORBIDDEN: "AGENT_EFFECT_FORBIDDEN",
  ACCEPTANCE_EVIDENCE_REQUIRED: "ACCEPTANCE_EVIDENCE_REQUIRED",
  LEDGER_HASH_INVALID: "LEDGER_HASH_INVALID",
  RUN_RESUME_REQUIRED: "RUN_RESUME_REQUIRED",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVENT_TYPES = new Set([
  "transition.requested",
  "transition.executed",
  "transition.completed",
  "transition.rejected",
  "authorization.granted",
  "authorization.revoked",
  "gate.satisfied",
  "run.resumed",
]);

export class WorkflowContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function workflowOk(data) {
  if (data === undefined || data === null || !isJsonValue(data)) throw invalid("Successful responses require JSON data");
  return { ok: true, data, error: null };
}

export function workflowFailure(code, message, details = undefined) {
  const error = normalizeError({ code, message, ...(details === undefined ? {} : { details }) });
  return { ok: false, data: null, error };
}

export function normalizeWorkflowResponse(value) {
  const response = objectOnly(value, "Response");
  rejectUnknown(response, ["ok", "data", "error"], "Response");
  if (response.ok === true && response.error === null && Object.hasOwn(response, "data") && response.data !== null && isJsonValue(response.data)) {
    return { ok: true, data: structuredClone(response.data), error: null };
  }
  if (response.ok === false && response.data === null && response.error !== null) {
    return { ok: false, data: null, error: normalizeError(response.error) };
  }
  throw invalid("Response must use the canonical { ok, data, error } envelope");
}

/**
 * A revision is a self-contained, immutable policy snapshot. Storing it or
 * moving aggregate state remains the TransitionService's responsibility.
 */
export function normalizeWorkflowRevision(value) {
  const object = objectOnly(value, "Workflow revision");
  rejectUnknown(object, ["schemaVersion", "workflowId", "revisionId", "revision", "createdAt", "immutable", "agentProfileRevisions", "stages", "gates", "transitions"], "Workflow revision");
  if (object.schemaVersion !== WORKFLOW_CONTROL_SCHEMA_VERSION) throw invalid("Workflow revision schemaVersion must be 1");
  if (!validIdentifier(object.workflowId)) throw invalid("workflowId must be a stable identifier");
  if (!validUuid(object.revisionId)) throw invalid("revisionId must be a UUID");
  if (!Number.isSafeInteger(object.revision) || object.revision < 1) throw invalid("revision must be a positive integer");
  if (!validTimestamp(object.createdAt)) throw invalid("createdAt must be an ISO-8601 timestamp");
  if (object.immutable !== true) throw invalid("Workflow revisions must declare immutable: true");
  if (!Array.isArray(object.agentProfileRevisions) || object.agentProfileRevisions.length === 0) throw invalid("agentProfileRevisions must contain at least one immutable profile revision");
  if (!Array.isArray(object.stages) || object.stages.length === 0) throw invalid("stages must contain at least one stage");
  if (!Array.isArray(object.gates)) throw invalid("gates must be an array");
  if (!Array.isArray(object.transitions) || object.transitions.length === 0) throw invalid("transitions must contain at least one transition");

  const agentProfileRevisions = object.agentProfileRevisions.map((profile, index) => normalizeAgentProfileRevision(profile, index));
  unique(agentProfileRevisions.map((profile) => profile.agentProfileRevisionId), "agentProfileRevisionId");
  const profilesByRevisionId = new Map(agentProfileRevisions.map((profile) => [profile.agentProfileRevisionId, profile]));
  const stages = object.stages.map((stage, index) => normalizeStage(stage, index, profilesByRevisionId));
  unique(stages.map((stage) => stage.stageId), "stageId");
  const stageById = new Map(stages.map((stage) => [stage.stageId, stage]));
  const gates = object.gates.map((gate, index) => normalizeGate(gate, index));
  unique(gates.map((gate) => gate.gateId), "gateId");
  const gatesById = new Map(gates.map((gate) => [gate.gateId, gate]));
  const transitions = object.transitions.map((transition, index) => normalizeTransition(transition, index, stageById, gatesById));
  unique(transitions.map((transition) => transition.transitionId), "transitionId");

  return deepFreeze({
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    workflowId: object.workflowId,
    revisionId: object.revisionId,
    revision: object.revision,
    createdAt: object.createdAt,
    immutable: true,
    agentProfileRevisions,
    stages,
    gates,
    transitions,
  });
}

/** Enforces append-only numbering only; it deliberately does not write storage. */
export function assertWorkflowRevisionPublication(previous, candidate) {
  const next = normalizeWorkflowRevision(candidate);
  if (previous === null || previous === undefined) {
    if (next.revision !== 1) throw invalid("The first workflow revision must be revision 1");
    return next;
  }
  const stored = normalizeWorkflowRevision(previous);
  if (stored.workflowId !== next.workflowId) throw invalid("A new revision must keep its workflowId");
  if (stored.revisionId === next.revisionId || next.revision !== stored.revision + 1) {
    throw new WorkflowContractError(
      WORKFLOW_ERROR_CODES.REVISION_IMMUTABLE,
      "Existing workflow revisions cannot be overwritten; publish the next revision instead",
    );
  }
  return next;
}

/**
 * Agent profiles are versioned. Disabled, manual, and shadow profiles remain
 * effect-free: a later adapter can only receive an explicitly dispatched run.
 * A human-operated actor belongs to a different contract, not an agent profile.
 */
export function normalizeAgentProfile(value) {
  return normalizeAgentProfileRevision(value, undefined);
}

export function assertAgentOperation(profile, operation) {
  const normalized = normalizeAgentProfile(profile);
  if (operation !== "read" && operation !== "mutation" && operation !== "external_call") throw invalid("Unknown agent operation");
  if (operation !== "read") {
    throw new WorkflowContractError(
      WORKFLOW_ERROR_CODES.AGENT_EFFECT_FORBIDDEN,
      "Disabled, manual, and shadow agent profiles are read-only in this contract phase",
      { mode: normalized.mode, operation },
    );
  }
  return normalized;
}

export function normalizeHumanAuthorization(value) {
  const object = objectOnly(value, "Human authorization");
  rejectUnknown(object, ["authorizationId", "kind", "action", "scope", "authorizedBy", "grantedAt", "expiresAt", "status", "grant", "revocation"], "Human authorization");
  if (!validUuid(object.authorizationId) || object.kind !== "human" || !validIdentifier(object.action)) throw invalid("Human authorization identity is invalid");
  const scope = normalizeAuthorizationScope(object.scope);
  const authorizedBy = normalizeHumanActor(object.authorizedBy, "authorizedBy");
  if (!validTimestamp(object.grantedAt) || (object.expiresAt !== null && !validTimestamp(object.expiresAt))) throw invalid("Authorization timestamps are invalid");
  if (object.expiresAt !== null && Date.parse(object.expiresAt) <= Date.parse(object.grantedAt)) throw invalid("expiresAt must be later than grantedAt");
  if (object.status !== "active" && object.status !== "revoked") throw invalid("Authorization status must be active or revoked");
  const grant = normalizeGrantReference(object.grant);
  const revocation = normalizeRevocation(object.revocation, "authorization");
  if ((object.status === "active") !== (revocation === null)) throw invalid("Active authorizations have no revocation; revoked authorizations require one");
  if (revocation && Date.parse(revocation.revokedAt) < Date.parse(object.grantedAt)) throw invalid("Authorization revocation cannot predate its grant");
  return deepFreeze({ ...object, scope, authorizedBy, grant, revocation });
}

/** Exact scope matching rejects a broad, revoked, or nearby approval. */
export function assertHumanAuthorization(authorization, expected) {
  const approved = normalizeHumanAuthorization(authorization);
  const required = objectOnly(expected, "Expected authorization");
  rejectUnknown(required, ["action", "workflowId", "revisionId", "transitionId", "target", "at"], "Expected authorization");
  if (!validIdentifier(required.action) || !validIdentifier(required.workflowId) || !validUuid(required.revisionId) || !validIdentifier(required.transitionId)) throw invalid("Expected authorization scope is invalid");
  const expectedScope = { workflowId: required.workflowId, revisionId: required.revisionId, transitionId: required.transitionId, target: normalizeTarget(required.target) };
  if (approved.status === "revoked") {
    throw new WorkflowContractError(WORKFLOW_ERROR_CODES.AUTHORIZATION_REVOKED, "Human authorization has been revoked", { revocation: approved.revocation });
  }
  if (approved.action !== required.action || canonicalJson(approved.scope) !== canonicalJson(expectedScope)) {
    throw new WorkflowContractError(WORKFLOW_ERROR_CODES.HUMAN_AUTH_SCOPE_MISMATCH, "Human authorization does not exactly cover this action", { expected: expectedScope });
  }
  if (required.at !== undefined && (!validTimestamp(required.at) || (approved.expiresAt !== null && Date.parse(required.at) > Date.parse(approved.expiresAt)))) {
    throw new WorkflowContractError(WORKFLOW_ERROR_CODES.HUMAN_AUTH_REQUIRED, "Human authorization is expired for this action");
  }
  return approved;
}

/**
 * Evaluates a requested transition only. It neither performs an effect nor
 * turns a successful execution record into human acceptance.
 */
export function evaluateTransition(revision, attempt) {
  try {
    const workflow = normalizeWorkflowRevision(revision);
    const request = normalizeTransitionAttempt(attempt);
    const transition = workflow.transitions.find((item) => item.transitionId === request.transitionId);
    if (!transition || transition.fromStageId !== request.fromStageId || transition.toStageId !== request.toStageId) {
      throw new WorkflowContractError(WORKFLOW_ERROR_CODES.TRANSITION_NOT_ALLOWED, "Transition is not defined by this workflow revision");
    }
    for (const gateId of transition.gateIds) {
      const gate = workflow.gates.find((item) => item.gateId === gateId);
      const evidence = request.gateEvidence.filter((item) => item.gateId === gateId && item.status === "valid");
      if (gate.kind === "acceptance" && !evidence.some((item) => item.type === "human_acceptance" && item.actor.kind === "human")) {
        throw new WorkflowContractError(WORKFLOW_ERROR_CODES.ACCEPTANCE_EVIDENCE_REQUIRED, "Transition requires valid human acceptance evidence", { gateId });
      }
      if (!gate.requiredEvidenceTypes.every((type) => evidence.some((item) => item.type === type))) {
        throw new WorkflowContractError(WORKFLOW_ERROR_CODES.GATE_UNSATISFIED, `Gate ${gateId} is missing required evidence`, { gateId });
      }
    }
    if (transition.authorization.required) {
      if (!request.humanAuthorization) throw new WorkflowContractError(WORKFLOW_ERROR_CODES.HUMAN_AUTH_REQUIRED, "This transition requires an exact human authorization");
      assertHumanAuthorization(request.humanAuthorization, {
        action: transition.authorization.action,
        workflowId: workflow.workflowId,
        revisionId: workflow.revisionId,
        transitionId: transition.transitionId,
        target: request.target,
        at: request.occurredAt,
      });
    }
    return workflowOk({ workflowId: workflow.workflowId, revisionId: workflow.revisionId, transitionId: transition.transitionId, allowed: true });
  } catch (error) {
    if (error instanceof WorkflowContractError) return workflowFailure(error.code, error.message, error.details);
    throw error;
  }
}

export function createLedgerEventEnvelope(value) {
  const normalized = normalizeLedgerEventEnvelope({ ...objectOnly(value, "Ledger event"), eventHash: undefined }, { allowMissingHash: true });
  return deepFreeze({ ...normalized, eventHash: ledgerEventHash(normalized) });
}

export function normalizeLedgerEventEnvelope(value, { allowMissingHash = false } = {}) {
  const object = objectOnly(value, "Ledger event");
  rejectUnknown(object, ["schemaVersion", "eventId", "eventType", "occurredAt", "workflowId", "revisionId", "aggregateType", "aggregateId", "correlationId", "causationId", "idempotencyKey", "prevHash", "runId", "payload", "eventHash"], "Ledger event");
  if (object.schemaVersion !== LEDGER_EVENT_SCHEMA_VERSION) throw invalid("Ledger event schemaVersion must be 1");
  if (!validUuid(object.eventId) || !EVENT_TYPES.has(object.eventType) || !validTimestamp(object.occurredAt)) throw invalid("Ledger event identity is invalid");
  if (!validIdentifier(object.workflowId) || !validUuid(object.revisionId) || !validIdentifier(object.aggregateType) || !validReferenceId(object.aggregateId)) throw invalid("Ledger event aggregate fields are invalid");
  if (!validUuid(object.correlationId) || (object.causationId !== null && !validUuid(object.causationId))) throw invalid("Ledger event correlation fields are invalid");
  if (!validIdentifier(object.idempotencyKey) || (object.prevHash !== null && (!isString(object.prevHash) || !SHA256.test(object.prevHash)))) throw invalid("Ledger event chain fields are invalid");
  if (object.runId !== undefined && !validUuid(object.runId)) throw invalid("Ledger event runId must be a UUID when supplied");
  if (object.eventType === "run.resumed" && object.runId === undefined) throw invalid("run.resumed events require runId");
  const payload = normalizeLedgerPayload(object.eventType, object.payload);
  const normalized = {
    ...object,
    ...(object.runId === undefined ? {} : { runId: object.runId }),
    payload,
  };
  if (object.eventHash === undefined && allowMissingHash) return normalized;
  if (!isString(object.eventHash) || !SHA256.test(object.eventHash)) throw invalid("Ledger eventHash must be a SHA-256 hex digest");
  if (ledgerEventHash(normalized) !== normalized.eventHash) {
    throw new WorkflowContractError(WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID, "Ledger eventHash does not match the canonical event envelope");
  }
  return deepFreeze(normalized);
}

export function ledgerEventHash(event) {
  const { eventHash: _ignored, ...hashable } = objectOnly(event, "Ledger event");
  return createHash("sha256").update(canonicalJson(hashable)).digest("hex");
}

export function canonicalJson(value) {
  if (!isJsonValue(value)) throw invalid("Canonical JSON only supports JSON data");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeAgentProfileRevision(value, index) {
  const label = index === undefined ? "Agent profile revision" : `agentProfileRevisions[${index}]`;
  const profile = objectOnly(value, label);
  rejectUnknown(profile, ["agentProfileId", "agentProfileRevisionId", "revision", "createdAt", "immutable", "mode"], label);
  if (!validIdentifier(profile.agentProfileId) || !validUuid(profile.agentProfileRevisionId) || !Number.isSafeInteger(profile.revision) || profile.revision < 1 || !validTimestamp(profile.createdAt) || profile.immutable !== true || !["disabled", "manual", "shadow"].includes(profile.mode)) {
    throw invalid(`${label} is invalid`);
  }
  return deepFreeze({ ...profile });
}

function normalizeStage(value, index, profilesByRevisionId) {
  const stage = objectOnly(value, `stages[${index}]`);
  rejectUnknown(stage, ["stageId", "name", "terminalKind", "agentProfileRevisionId"], `stages[${index}]`);
  if (!validIdentifier(stage.stageId) || !isString(stage.name) || !stage.name.trim()) throw invalid(`stages[${index}] is invalid`);
  if (!["none", "completed", "canceled"].includes(stage.terminalKind)) throw invalid(`stages[${index}].terminalKind is invalid`);
  if (!validUuid(stage.agentProfileRevisionId) || !profilesByRevisionId.has(stage.agentProfileRevisionId)) throw invalid(`stages[${index}] must reference a declared agentProfileRevisionId`);
  return { stageId: stage.stageId, name: stage.name.trim(), terminalKind: stage.terminalKind, agentProfileRevisionId: stage.agentProfileRevisionId };
}

function normalizeGate(value, index) {
  const gate = objectOnly(value, `gates[${index}]`);
  rejectUnknown(gate, ["gateId", "kind", "requiredEvidenceTypes"], `gates[${index}]`);
  if (!validIdentifier(gate.gateId) || (gate.kind !== "evidence" && gate.kind !== "acceptance") || !Array.isArray(gate.requiredEvidenceTypes) || gate.requiredEvidenceTypes.length === 0 || gate.requiredEvidenceTypes.some((type) => !validIdentifier(type))) throw invalid(`gates[${index}] is invalid`);
  unique(gate.requiredEvidenceTypes, `gates[${index}].requiredEvidenceTypes`);
  if (gate.kind === "acceptance" && !gate.requiredEvidenceTypes.includes("human_acceptance")) throw invalid("Acceptance gates must require human_acceptance evidence");
  return { gateId: gate.gateId, kind: gate.kind, requiredEvidenceTypes: [...gate.requiredEvidenceTypes] };
}

function normalizeTransition(value, index, stages, gates) {
  const transition = objectOnly(value, `transitions[${index}]`);
  rejectUnknown(transition, ["transitionId", "fromStageId", "toStageId", "requiresAcceptance", "irreversible", "gateIds", "authorization"], `transitions[${index}]`);
  if (!validIdentifier(transition.transitionId) || !stages.has(transition.fromStageId) || !stages.has(transition.toStageId) || typeof transition.requiresAcceptance !== "boolean" || typeof transition.irreversible !== "boolean" || !Array.isArray(transition.gateIds) || transition.gateIds.some((gateId) => !gates.has(gateId))) throw invalid(`transitions[${index}] is invalid`);
  unique(transition.gateIds, `transitions[${index}].gateIds`);
  const authorization = objectOnly(transition.authorization, `transitions[${index}].authorization`);
  rejectUnknown(authorization, ["required", "action"], `transitions[${index}].authorization`);
  if (typeof authorization.required !== "boolean" || (authorization.required ? !validIdentifier(authorization.action) : authorization.action !== null)) throw invalid(`transitions[${index}].authorization is invalid`);
  const hasAcceptanceGate = transition.gateIds.some((gateId) => gates.get(gateId).kind === "acceptance");
  const target = stages.get(transition.toStageId);
  if (transition.requiresAcceptance && !hasAcceptanceGate) throw invalid("Transitions that require acceptance must include an acceptance gate");
  if (target.terminalKind === "completed" && (!transition.requiresAcceptance || !hasAcceptanceGate)) {
    throw invalid("Every transition into a completed terminal stage requires human acceptance");
  }
  if (transition.irreversible && !authorization.required) throw invalid("Irreversible transitions require human authorization");
  return {
    transitionId: transition.transitionId,
    fromStageId: transition.fromStageId,
    toStageId: transition.toStageId,
    requiresAcceptance: transition.requiresAcceptance,
    irreversible: transition.irreversible,
    gateIds: [...transition.gateIds],
    authorization: { ...authorization },
  };
}

function normalizeTransitionAttempt(value) {
  const attempt = objectOnly(value, "Transition attempt");
  rejectUnknown(attempt, ["transitionId", "fromStageId", "toStageId", "target", "occurredAt", "gateEvidence", "humanAuthorization"], "Transition attempt");
  if (!validIdentifier(attempt.transitionId) || !validIdentifier(attempt.fromStageId) || !validIdentifier(attempt.toStageId) || !validTimestamp(attempt.occurredAt) || !Array.isArray(attempt.gateEvidence)) throw invalid("Transition attempt is invalid");
  const target = normalizeTarget(attempt.target);
  const gateEvidence = attempt.gateEvidence.map((item, index) => normalizeEvidence(item, index));
  if (attempt.humanAuthorization !== undefined && attempt.humanAuthorization !== null) normalizeHumanAuthorization(attempt.humanAuthorization);
  return { ...attempt, target, gateEvidence, humanAuthorization: attempt.humanAuthorization ?? null };
}

function normalizeEvidence(value, index) {
  const evidence = objectOnly(value, `gateEvidence[${index}]`);
  rejectUnknown(evidence, ["evidenceId", "gateId", "type", "capturedAt", "actor", "status", "record", "revocation"], `gateEvidence[${index}]`);
  if (!validUuid(evidence.evidenceId) || !validIdentifier(evidence.gateId) || !validIdentifier(evidence.type) || !validTimestamp(evidence.capturedAt)) throw invalid(`gateEvidence[${index}] is invalid`);
  const actor = normalizeActor(evidence.actor, `gateEvidence[${index}].actor`);
  if (evidence.status !== "valid" && evidence.status !== "revoked") throw invalid(`gateEvidence[${index}].status is invalid`);
  const record = normalizeEvidenceReference(evidence.record);
  const revocation = normalizeRevocation(evidence.revocation, "evidence");
  if ((evidence.status === "valid") !== (revocation === null)) throw invalid("Valid evidence has no revocation; revoked evidence requires one");
  if (revocation && Date.parse(revocation.revokedAt) < Date.parse(evidence.capturedAt)) throw invalid("Evidence revocation cannot predate capture");
  return { ...evidence, actor, record, revocation };
}

function normalizeLedgerPayload(eventType, value) {
  const payload = objectOnly(value, `Ledger payload for ${eventType}`);
  if (eventType === "transition.requested") {
    rejectUnknown(payload, ["transitionId", "fromStageId", "toStageId", "target"], "transition.requested payload");
    if (!validIdentifier(payload.transitionId) || !validIdentifier(payload.fromStageId) || !validIdentifier(payload.toStageId)) throw invalid("transition.requested payload is invalid");
    return { ...payload, target: normalizeTarget(payload.target) };
  }
  if (eventType === "transition.executed") {
    rejectUnknown(payload, ["transitionId", "execution"], "transition.executed payload");
    if (!validIdentifier(payload.transitionId)) throw invalid("transition.executed payload is invalid");
    return { transitionId: payload.transitionId, execution: normalizeExecution(payload.execution) };
  }
  if (eventType === "transition.completed") {
    if (Object.hasOwn(payload, "acceptanceEvidenceId")) {
      throw new WorkflowContractError(WORKFLOW_ERROR_CODES.ACCEPTANCE_EVIDENCE_REQUIRED, "A completed transition must use a structured acceptance reference");
    }
    rejectUnknown(payload, ["transitionId", "acceptance"], "transition.completed payload");
    if (!validIdentifier(payload.transitionId)) throw invalid("transition.completed payload is invalid");
    return { transitionId: payload.transitionId, acceptance: normalizeAcceptanceReference(payload.acceptance) };
  }
  if (eventType === "transition.rejected") {
    rejectUnknown(payload, ["transitionId", "error"], "transition.rejected payload");
    if (!validIdentifier(payload.transitionId)) throw invalid("transition.rejected payload is invalid");
    return { transitionId: payload.transitionId, error: normalizeError(payload.error) };
  }
  if (eventType === "authorization.granted") {
    rejectUnknown(payload, ["authorizationId", "action", "scope", "grant"], "authorization.granted payload");
    if (!validUuid(payload.authorizationId) || !validIdentifier(payload.action)) throw invalid("authorization.granted payload is invalid");
    return { authorizationId: payload.authorizationId, action: payload.action, scope: normalizeAuthorizationScope(payload.scope), grant: normalizeGrantReference(payload.grant) };
  }
  if (eventType === "authorization.revoked") {
    rejectUnknown(payload, ["authorizationId", "revocation"], "authorization.revoked payload");
    if (!validUuid(payload.authorizationId)) throw invalid("authorization.revoked payload is invalid");
    const revocation = normalizeRevocation(payload.revocation, "authorization");
    if (!revocation) throw invalid("authorization.revoked payload requires revocation details");
    return { authorizationId: payload.authorizationId, revocation };
  }
  if (eventType === "gate.satisfied") {
    rejectUnknown(payload, ["gateId", "evidence"], "gate.satisfied payload");
    if (!validIdentifier(payload.gateId)) throw invalid("gate.satisfied payload is invalid");
    return { gateId: payload.gateId, evidence: normalizeAcceptanceReference(payload.evidence) };
  }
  rejectUnknown(payload, ["resumedFromEventId"], "run.resumed payload");
  if (!validUuid(payload.resumedFromEventId)) throw invalid("run.resumed payload is invalid");
  return { resumedFromEventId: payload.resumedFromEventId };
}

function normalizeExecution(value) {
  const execution = objectOnly(value, "Execution record");
  rejectUnknown(execution, ["status", "result"], "Execution record");
  if ((execution.status !== "succeeded" && execution.status !== "failed") || !Object.hasOwn(execution, "result") || !isJsonValue(execution.result)) throw invalid("Execution record is invalid");
  return { status: execution.status, result: structuredClone(execution.result) };
}

function normalizeAuthorizationScope(value) {
  const scope = objectOnly(value, "Authorization scope");
  rejectUnknown(scope, ["workflowId", "revisionId", "transitionId", "target"], "Authorization scope");
  if (!validIdentifier(scope.workflowId) || !validUuid(scope.revisionId) || !validIdentifier(scope.transitionId)) throw invalid("Authorization scope is invalid");
  return { workflowId: scope.workflowId, revisionId: scope.revisionId, transitionId: scope.transitionId, target: normalizeTarget(scope.target) };
}

function normalizeTarget(value) {
  const target = objectOnly(value, "Target");
  rejectUnknown(target, ["type", "id"], "Target");
  if (!validIdentifier(target.type) || !validReferenceId(target.id)) throw invalid("Target must have stable type and id");
  return { type: target.type, id: target.id };
}

function normalizeActor(value, label) {
  const actor = objectOnly(value, label);
  rejectUnknown(actor, ["actorId", "kind"], label);
  if (!validIdentifier(actor.actorId) || !["human", "agent", "system"].includes(actor.kind)) throw invalid(`${label} is invalid`);
  return { actorId: actor.actorId, kind: actor.kind };
}

function normalizeHumanActor(value, label) {
  const actor = normalizeActor(value, label);
  if (actor.kind !== "human") throw invalid(`${label} must identify a human`);
  return actor;
}

function normalizeGrantReference(value) {
  const grant = objectOnly(value, "Authorization grant reference");
  rejectUnknown(grant, ["grantEventId", "eventHash"], "Authorization grant reference");
  if (!validUuid(grant.grantEventId) || !isString(grant.eventHash) || !SHA256.test(grant.eventHash)) throw invalid("Authorization grant must reference a verifiable grant event");
  return { grantEventId: grant.grantEventId, eventHash: grant.eventHash };
}

function normalizeEvidenceReference(value) {
  const record = objectOnly(value, "Evidence record reference");
  rejectUnknown(record, ["evidenceEventId", "eventHash"], "Evidence record reference");
  if (!validUuid(record.evidenceEventId) || !isString(record.eventHash) || !SHA256.test(record.eventHash)) throw invalid("Evidence must reference a verifiable event record");
  return { evidenceEventId: record.evidenceEventId, eventHash: record.eventHash };
}

function normalizeAcceptanceReference(value) {
  const acceptance = objectOnly(value, "Acceptance reference");
  rejectUnknown(acceptance, ["evidenceId", "evidenceEventId", "eventHash"], "Acceptance reference");
  if (!validUuid(acceptance.evidenceId) || !validUuid(acceptance.evidenceEventId) || !isString(acceptance.eventHash) || !SHA256.test(acceptance.eventHash)) throw new WorkflowContractError(WORKFLOW_ERROR_CODES.ACCEPTANCE_EVIDENCE_REQUIRED, "Acceptance must contain a verifiable evidence reference");
  return { evidenceId: acceptance.evidenceId, evidenceEventId: acceptance.evidenceEventId, eventHash: acceptance.eventHash };
}

function normalizeRevocation(value, subject) {
  if (value === null) return null;
  const revocation = objectOnly(value, `${subject} revocation`);
  rejectUnknown(revocation, ["revokedEventId", "eventHash", "revokedAt", "reason"], `${subject} revocation`);
  if (!validUuid(revocation.revokedEventId) || !isString(revocation.eventHash) || !SHA256.test(revocation.eventHash) || !validTimestamp(revocation.revokedAt) || !isString(revocation.reason) || !revocation.reason.trim()) throw invalid(`${subject} revocation is invalid`);
  return { revokedEventId: revocation.revokedEventId, eventHash: revocation.eventHash, revokedAt: revocation.revokedAt, reason: revocation.reason.trim() };
}

function normalizeError(value) {
  const error = objectOnly(value, "Workflow error");
  rejectUnknown(error, ["code", "message", "details"], "Workflow error");
  if (!Object.values(WORKFLOW_ERROR_CODES).includes(error.code) || !isString(error.message) || !error.message.trim() || (Object.hasOwn(error, "details") && !isJsonValue(error.details))) throw invalid("Workflow error is invalid");
  return { code: error.code, message: error.message, ...(Object.hasOwn(error, "details") ? { details: structuredClone(error.details) } : {}) };
}

function invalid(message) {
  return new WorkflowContractError(WORKFLOW_ERROR_CODES.INVALID_CONTRACT, message);
}

function objectOnly(value, label) {
  if (!isPlainObject(value)) throw invalid(`${label} must be an object`);
  return value;
}

function rejectUnknown(object, allowed, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw invalid(`${label} values must be unique`);
}

function validIdentifier(value) {
  return isString(value) && IDENTIFIER.test(value);
}

function validReferenceId(value) {
  return validIdentifier(value) || validUuid(value);
}

function validUuid(value) {
  return isString(value) && UUID.test(value);
}

function validTimestamp(value) {
  return isString(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isString(value) {
  return typeof value === "string";
}

function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

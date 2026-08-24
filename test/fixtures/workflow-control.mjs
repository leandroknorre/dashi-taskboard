import { randomUUID } from "node:crypto";

export const revisionId = "11111111-1111-4111-8111-111111111111";
export const agentProfileRevisionId = "12121212-1212-4121-8121-121212121212";
export const authorizationId = "22222222-2222-4222-8222-222222222222";
export const acceptanceEvidenceId = "33333333-3333-4333-8333-333333333333";
export const eventId = "44444444-4444-4444-8444-444444444444";
export const correlationId = "55555555-5555-4555-8555-555555555555";
export const evidenceEventId = "66666666-6666-4666-8666-666666666666";
export const grantEventId = "77777777-7777-4777-8777-777777777777";
export const revocationEventId = "88888888-8888-4888-8888-888888888888";

export const evidenceEventHash = "a".repeat(64);
export const grantEventHash = "b".repeat(64);
export const revocationEventHash = "c".repeat(64);

export function workflowRevision(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowId: "contract-review",
    revisionId,
    revision: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    immutable: true,
    agentProfileRevisions: [agentProfileRevision()],
    stages: [
      { stageId: "draft", name: "Draft", terminalKind: "none", agentProfileRevisionId },
      { stageId: "reviewed", name: "Reviewed", terminalKind: "none", agentProfileRevisionId },
      { stageId: "accepted", name: "Accepted", terminalKind: "completed", agentProfileRevisionId },
    ],
    gates: [
      { gateId: "review-evidence", kind: "evidence", requiredEvidenceTypes: ["review_record"] },
      { gateId: "human-acceptance", kind: "acceptance", requiredEvidenceTypes: ["human_acceptance"] },
    ],
    transitions: [
      {
        transitionId: "submit-review",
        fromStageId: "draft",
        toStageId: "reviewed",
        requiresAcceptance: false,
        irreversible: false,
        gateIds: ["review-evidence"],
        authorization: { required: false, action: null },
      },
      {
        transitionId: "complete-review",
        fromStageId: "reviewed",
        toStageId: "accepted",
        requiresAcceptance: true,
        irreversible: false,
        gateIds: ["human-acceptance"],
        authorization: { required: false, action: null },
      },
      {
        transitionId: "delete-record",
        fromStageId: "reviewed",
        toStageId: "draft",
        requiresAcceptance: false,
        irreversible: true,
        gateIds: [],
        authorization: { required: true, action: "delete_record" },
      },
    ],
    ...overrides,
  };
}

export function agentProfileRevision(overrides = {}) {
  return {
    agentProfileId: "review-agent",
    agentProfileRevisionId,
    revision: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    immutable: true,
    mode: "manual",
    ...overrides,
  };
}

export function acceptanceEvidence(overrides = {}) {
  return {
    evidenceId: acceptanceEvidenceId,
    gateId: "human-acceptance",
    type: "human_acceptance",
    capturedAt: "2026-08-24T12:05:00.000Z",
    actor: { actorId: "reviewer", kind: "human" },
    status: "valid",
    record: { evidenceEventId, eventHash: evidenceEventHash },
    revocation: null,
    ...overrides,
  };
}

export function humanAuthorization(overrides = {}) {
  return {
    authorizationId,
    kind: "human",
    action: "delete_record",
    scope: {
      workflowId: "contract-review",
      revisionId,
      transitionId: "delete-record",
      target: { type: "review", id: "review-1" },
    },
    authorizedBy: { actorId: "reviewer", kind: "human" },
    grantedAt: "2026-08-24T12:05:00.000Z",
    expiresAt: "2026-08-24T13:05:00.000Z",
    status: "active",
    grant: { grantEventId, eventHash: grantEventHash },
    revocation: null,
    ...overrides,
  };
}

export function revocation(overrides = {}) {
  return {
    revokedEventId: revocationEventId,
    eventHash: revocationEventHash,
    revokedAt: "2026-08-24T12:07:00.000Z",
    reason: "Human revoked this grant",
    ...overrides,
  };
}

export function transitionAttempt(overrides = {}) {
  return {
    transitionId: "complete-review",
    fromStageId: "reviewed",
    toStageId: "accepted",
    target: { type: "review", id: "review-1" },
    occurredAt: "2026-08-24T12:06:00.000Z",
    gateEvidence: [acceptanceEvidence()],
    humanAuthorization: null,
    ...overrides,
  };
}

export function ledgerEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId,
    eventType: "transition.completed",
    occurredAt: "2026-08-24T12:06:00.000Z",
    workflowId: "contract-review",
    revisionId,
    aggregateType: "review",
    aggregateId: "review-1",
    correlationId,
    causationId: null,
    idempotencyKey: "complete-review-1",
    prevHash: null,
    payload: {
      transitionId: "complete-review",
      acceptance: { evidenceId: acceptanceEvidenceId, evidenceEventId, eventHash: evidenceEventHash },
    },
    ...overrides,
  };
}

export function anotherRevisionId() {
  return randomUUID();
}

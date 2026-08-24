import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_ERROR_CODES,
  WorkflowContractError,
  assertAgentOperation,
  assertHumanAuthorization,
  assertWorkflowRevisionPublication,
  createLedgerEventEnvelope,
  evaluateTransition,
  ledgerEventHash,
  normalizeLedgerEventEnvelope,
  normalizeWorkflowResponse,
  normalizeWorkflowRevision,
  workflowFailure,
  workflowOk,
} from "../shared/workflow-control.mjs";
import {
  acceptanceEvidence,
  agentProfileRevision,
  anotherRevisionId,
  humanAuthorization,
  ledgerEvent,
  revocation,
  transitionAttempt,
  workflowRevision,
} from "./fixtures/workflow-control.mjs";

test("workflow revisions are immutable snapshots; the first is 1 and later revisions are sequential", () => {
  const first = normalizeWorkflowRevision(workflowRevision());
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.transitions[0]));
  assert.equal(first.stages[0].agentProfileRevisionId, agentProfileRevision().agentProfileRevisionId);
  assert.equal(assertWorkflowRevisionPublication(null, first).revision, 1);

  const second = workflowRevision({ revisionId: anotherRevisionId(), revision: 2 });
  assert.equal(assertWorkflowRevisionPublication(first, second).revision, 2);
  assert.throws(
    () => assertWorkflowRevisionPublication(null, workflowRevision({ revisionId: anotherRevisionId(), revision: 2 })),
    /first workflow revision must be revision 1/,
  );
  assert.throws(
    () => assertWorkflowRevisionPublication(first, workflowRevision({ revisionId: anotherRevisionId(), revision: 1 })),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.REVISION_IMMUTABLE,
  );
});

test("every completed terminal destination requires acceptance, independently of irreversibility", () => {
  const normalBypass = workflowRevision({
    transitions: workflowRevision().transitions.map((transition) => transition.transitionId === "complete-review"
      ? { ...transition, requiresAcceptance: false, gateIds: [] }
      : transition),
  });
  assert.throws(() => normalizeWorkflowRevision(normalBypass), /completed terminal stage requires human acceptance/);

  const irreversibleBypass = workflowRevision({
    transitions: workflowRevision().transitions.map((transition) => transition.transitionId === "complete-review"
      ? { ...transition, irreversible: true, requiresAcceptance: false, gateIds: [] }
      : transition),
  });
  assert.throws(() => normalizeWorkflowRevision(irreversibleBypass), /completed terminal stage requires human acceptance/);

  const authorizationBypass = workflowRevision({
    transitions: workflowRevision().transitions.map((transition) => transition.transitionId === "delete-record"
      ? { ...transition, authorization: { required: false, action: null } }
      : transition),
  });
  assert.throws(() => normalizeWorkflowRevision(authorizationBypass), /Irreversible transitions require human authorization/);
});

test("execution success is not acceptance; valid human evidence with an event record is", () => {
  const noAcceptance = evaluateTransition(workflowRevision(), transitionAttempt({
    gateEvidence: [{ ...acceptanceEvidence(), type: "execution_succeeded", actor: { actorId: "runner", kind: "agent" } }],
  }));
  assert.equal(noAcceptance.error.code, WORKFLOW_ERROR_CODES.ACCEPTANCE_EVIDENCE_REQUIRED);
  assert.equal(evaluateTransition(workflowRevision(), transitionAttempt()).ok, true);

  const revokedEvidence = evaluateTransition(workflowRevision(), transitionAttempt({
    gateEvidence: [acceptanceEvidence({ status: "revoked", revocation: revocation() })],
  }));
  assert.equal(revokedEvidence.error.code, WORKFLOW_ERROR_CODES.ACCEPTANCE_EVIDENCE_REQUIRED);
});

test("irreversible transitions need an active human grant with exact scope", () => {
  const request = transitionAttempt({
    transitionId: "delete-record",
    fromStageId: "reviewed",
    toStageId: "draft",
    gateEvidence: [],
    humanAuthorization: null,
  });
  assert.equal(evaluateTransition(workflowRevision(), request).error.code, WORKFLOW_ERROR_CODES.HUMAN_AUTH_REQUIRED);
  assert.equal(evaluateTransition(workflowRevision(), { ...request, humanAuthorization: humanAuthorization() }).ok, true);
  assert.equal(evaluateTransition(workflowRevision(), {
    ...request,
    humanAuthorization: humanAuthorization({ status: "revoked", revocation: revocation() }),
  }).error.code, WORKFLOW_ERROR_CODES.AUTHORIZATION_REVOKED);

  assert.throws(
    () => assertHumanAuthorization(humanAuthorization({ scope: { ...humanAuthorization().scope, target: { type: "review", id: "review-2" } } }), {
      action: "delete_record",
      workflowId: "contract-review",
      revisionId: workflowRevision().revisionId,
      transitionId: "delete-record",
      target: { type: "review", id: "review-1" },
      at: "2026-08-24T12:06:00.000Z",
    }),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.HUMAN_AUTH_SCOPE_MISMATCH,
  );
});

test("manual and shadow are both read-only agent profile revisions", () => {
  for (const mode of ["manual", "shadow"]) {
    const profile = agentProfileRevision({ mode });
    assert.equal(assertAgentOperation(profile, "read").mode, mode);
    for (const operation of ["mutation", "external_call"]) {
      assert.throws(
        () => assertAgentOperation(profile, operation),
        (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.AGENT_EFFECT_FORBIDDEN,
      );
    }
  }
});

test("ledger envelopes require aggregates, optional runs, typed payloads, and verifiable acceptance references", () => {
  const event = createLedgerEventEnvelope(ledgerEvent({ runId: "99999999-9999-4999-8999-999999999999" }));
  assert.match(event.eventHash, /^[0-9a-f]{64}$/);
  assert.equal(ledgerEventHash(event), event.eventHash);
  assert.deepEqual(normalizeLedgerEventEnvelope(event), event);
  assert.equal(event.runId, "99999999-9999-4999-8999-999999999999");
  assert.throws(() => createLedgerEventEnvelope(ledgerEvent({ aggregateType: undefined })), /aggregate fields are invalid/);
  assert.throws(
    () => createLedgerEventEnvelope(ledgerEvent({ payload: { transitionId: "complete-review", acceptanceEvidenceId: acceptanceEvidence().evidenceId } })),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.ACCEPTANCE_EVIDENCE_REQUIRED,
  );
  assert.throws(
    () => normalizeLedgerEventEnvelope({ ...event, payload: { ...event.payload, transitionId: "other-transition" } }),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );
});

test("every declared ledger event type has a closed, typed payload contract", () => {
  const authorization = humanAuthorization();
  const evidence = acceptanceEvidence();
  const eventPayloads = new Map([
    ["transition.requested", {
      transitionId: "complete-review",
      fromStageId: "reviewed",
      toStageId: "accepted",
      target: { type: "review", id: "review-1" },
    }],
    ["transition.executed", {
      transitionId: "complete-review",
      execution: { status: "succeeded", result: { output: "worker result" } },
    }],
    ["transition.rejected", {
      transitionId: "complete-review",
      error: { code: WORKFLOW_ERROR_CODES.GATE_UNSATISFIED, message: "Evidence missing" },
    }],
    ["authorization.granted", {
      authorizationId: authorization.authorizationId,
      action: authorization.action,
      scope: authorization.scope,
      grant: authorization.grant,
    }],
    ["authorization.revoked", {
      authorizationId: authorization.authorizationId,
      revocation: revocation(),
    }],
    ["gate.satisfied", {
      gateId: evidence.gateId,
      evidence: {
        evidenceId: evidence.evidenceId,
        evidenceEventId: evidence.record.evidenceEventId,
        eventHash: evidence.record.eventHash,
      },
    }],
    ["run.resumed", { resumedFromEventId: evidence.record.evidenceEventId }],
  ]);
  for (const [eventType, payload] of eventPayloads) {
    const overrides = eventType === "run.resumed"
      ? { eventType, payload, runId: "99999999-9999-4999-8999-999999999999" }
      : { eventType, payload };
    assert.match(createLedgerEventEnvelope(ledgerEvent(overrides)).eventHash, /^[0-9a-f]{64}$/);
    assert.throws(
      () => createLedgerEventEnvelope(ledgerEvent({ ...overrides, payload: { ...payload, unexpected: true } })),
      (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.INVALID_CONTRACT,
    );
  }
  assert.throws(() => createLedgerEventEnvelope(ledgerEvent({ eventType: "run.resumed", payload: { resumedFromEventId: evidence.record.evidenceEventId } })), /run\.resumed events require runId/);
});

test("canonical workflow responses require success data and include conflict, revocation, and resume errors", () => {
  assert.deepEqual(normalizeWorkflowResponse(workflowOk({ transitionId: "submit-review" })), workflowOk({ transitionId: "submit-review" }));
  assert.throws(() => workflowOk(), /require JSON data/);
  assert.throws(() => normalizeWorkflowResponse({ ok: true, error: null }), /canonical/);
  for (const code of [
    WORKFLOW_ERROR_CODES.STATE_CONFLICT,
    WORKFLOW_ERROR_CODES.IDEMPOTENCY_CONFLICT,
    WORKFLOW_ERROR_CODES.AUTHORIZATION_REVOKED,
    WORKFLOW_ERROR_CODES.RUN_RESUME_REQUIRED,
  ]) {
    assert.deepEqual(normalizeWorkflowResponse(workflowFailure(code, "Contractual error")), workflowFailure(code, "Contractual error"));
  }
});

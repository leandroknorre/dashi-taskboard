import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkflowContractError,
  createLedgerEventEnvelope,
  normalizeWorkflowRevision,
} from "../shared/workflow-control.mjs";
import { ledgerEvent, workflowRevision } from "./fixtures/workflow-control.mjs";

function clone(value) {
  return structuredClone(value);
}

test("deterministic contract fuzz rejects terminal, profile, aggregate, and typed-payload bypasses", () => {
  const cases = [
    (value) => { value.stages[0].agentProfileRevisionId = "not-a-uuid"; },
    (value) => { value.agentProfileRevisions[0].mode = "autonomous"; },
    (value) => { value.transitions[1].requiresAcceptance = false; },
    (value) => { value.transitions[1].gateIds = []; },
    (value) => { value.transitions[2].authorization = { required: false, action: null }; },
    (value) => { value.transitions[0].irreversible = "false"; },
  ];
  for (let index = 0; index < 120; index += 1) {
    const candidate = clone(workflowRevision());
    cases[index % cases.length](candidate);
    assert.throws(
      () => normalizeWorkflowRevision(candidate),
      (error) => error instanceof WorkflowContractError,
      `revision mutation ${index} must be rejected`,
    );
  }

  const eventCases = [
    (value) => { value.aggregateType = null; },
    (value) => { value.aggregateId = []; },
    (value) => { value.runId = "not-a-uuid"; },
    (value) => { value.payload.acceptance = { evidenceId: value.payload.acceptance.evidenceId }; },
    (value) => { value.payload = { transitionId: "complete-review", acceptance: value.payload.acceptance, extra: true }; },
  ];
  for (let index = 0; index < 100; index += 1) {
    const candidate = clone(ledgerEvent());
    eventCases[index % eventCases.length](candidate);
    assert.throws(
      () => createLedgerEventEnvelope(candidate),
      (error) => error instanceof WorkflowContractError,
      `event mutation ${index} must be rejected`,
    );
  }
});

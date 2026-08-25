import { createHash } from "node:crypto";

import { canonicalJson } from "./workflow-control.mjs";

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(?:authorization|api[_-]?key|cookie|credential|password|secret|token)/i;

export const AUTOMATION_RUN_MODES = Object.freeze(["disabled", "manual", "shadow"]);
export const AUTOMATION_RUN_STATUSES = Object.freeze([
  "pending", "dispatched", "succeeded", "failed", "cancelled",
]);

export const AUTOMATION_RUN_ERROR_CODES = Object.freeze({
  RUN_NOT_FOUND: "AUTOMATION_RUN_NOT_FOUND",
  INVALID_COMMAND: "AUTOMATION_RUN_INVALID_COMMAND",
  IDEMPOTENCY_CONFLICT: "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  VERSION_CONFLICT: "AUTOMATION_RUN_VERSION_CONFLICT",
  DISPATCH_FORBIDDEN: "AUTOMATION_RUN_DISPATCH_FORBIDDEN",
  NOT_DISPATCHABLE: "AUTOMATION_RUN_NOT_DISPATCHABLE",
  LEASE_INVALID: "AUTOMATION_RUN_LEASE_INVALID",
  LEASE_EXPIRED: "AUTOMATION_RUN_LEASE_EXPIRED",
  RESULT_NOT_ALLOWED: "AUTOMATION_RUN_RESULT_NOT_ALLOWED",
  PAYLOAD_TOO_LARGE: "AUTOMATION_RUN_PAYLOAD_TOO_LARGE",
});

export class AutomationRunError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AutomationRunError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeAutomationMode(value) {
  if (!AUTOMATION_RUN_MODES.includes(value)) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "Automation mode must be disabled, manual, or shadow");
  }
  return value;
}

export function automationRunIdForTransitionEvent(transitionEventId) {
  if (typeof transitionEventId !== "string" || !UUID.test(transitionEventId)) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "Transition event id must be a UUID");
  }
  const digest = createHash("sha256").update(`dashi-automation-run:${transitionEventId}`).digest("hex");
  const variant = (8 + (Number.parseInt(digest[16], 16) % 4)).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function normalizeDispatchCommand(value) {
  const command = plainObject(value, "Dispatch command");
  rejectUnknown(command, ["expectedVersion", "leaseSeconds", "idempotencyKey"], "Dispatch command");
  const expectedVersion = positiveInteger(command.expectedVersion, "expectedVersion");
  const leaseSeconds = command.leaseSeconds === undefined ? 300 : positiveInteger(command.leaseSeconds, "leaseSeconds");
  if (leaseSeconds < 30 || leaseSeconds > 900) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "leaseSeconds must be between 30 and 900");
  }
  return {
    expectedVersion,
    leaseSeconds,
    idempotencyKey: idempotencyKey(command.idempotencyKey),
  };
}

export function normalizeResultCommand(value) {
  const command = plainObject(value, "Run result");
  rejectUnknown(command, ["expectedVersion", "leaseToken", "status", "result", "idempotencyKey"], "Run result");
  const expectedVersion = positiveInteger(command.expectedVersion, "expectedVersion");
  if (typeof command.leaseToken !== "string" || !UUID.test(command.leaseToken)) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "leaseToken must be the active dispatch lease");
  }
  if (!["succeeded", "failed", "cancelled"].includes(command.status)) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.RESULT_NOT_ALLOWED, "Run results must be succeeded, failed, or cancelled");
  }
  return {
    expectedVersion,
    leaseToken: command.leaseToken,
    status: command.status,
    result: redactAndLimit(command.result ?? {}),
    idempotencyKey: idempotencyKey(command.idempotencyKey),
  };
}

export function redactAndLimit(value, { limit = 16 * 1024 } = {}) {
  const redacted = redact(value, 0);
  let serialized;
  try {
    serialized = canonicalJson(redacted);
  } catch {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "Automation payload must be JSON data");
  }
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.PAYLOAD_TOO_LARGE, `Automation payload cannot exceed ${limit} bytes`);
  }
  return redacted;
}

export function automationRequestFingerprint(operation, runId, command) {
  return canonicalJson({ operation, runId, ...command });
}

function redact(value, depth) {
  if (depth > 12) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.PAYLOAD_TOO_LARGE, "Automation payload nesting cannot exceed 12 levels");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 100) {
      throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.PAYLOAD_TOO_LARGE, "Automation payload objects cannot contain more than 100 keys");
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1)]));
  }
  throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "Automation payload must be JSON data");
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, `${label} must be an object`);
  }
  return value;
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, `${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, `${label} must be a positive integer`);
  }
  return value;
}

function idempotencyKey(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND, "idempotencyKey must be a stable identifier");
  }
  return value;
}

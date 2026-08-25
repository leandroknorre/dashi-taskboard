# Cloud TransitionService boundary

Cloud workflow state changes use `POST /api/tasks/:id/transitions`. The
request requires `expectedStateVersion`, `actionKey`, an `Idempotency-Key`,
and, when the destination is completed, a server-attested human acceptance
record in `gateEvidence`.

Human acceptance is created separately by a trusted human operator:

`POST /api/tasks/:id/evidence`

The request contains `expectedStateVersion`, `actionKey`, optional `gateId`
(required when an action has more than one acceptance gate), and an
`Idempotency-Key`. Its `X-Taskboard-Human-Acceptance` header is a compact,
short-lived assertion, not a password:

`v1.<base64url-json>.<base64url-hmac-sha256>`

A trusted server-side human-operator issuer signs `v1.<base64url-json>` using
`TASKBOARD_HUMAN_ACCEPTANCE_SECRET`. The Worker recomputes and compares that
HMAC timing-safely. The assertion contains an opaque non-PII `subject`, route,
HTTP method, task ID, expected state version, action, exact gate, idempotency
key, issued/expiry times (at most five minutes), and nonce. The signed subject
alone determines the persistent actor key; a Basic username, session cookie,
or `x-taskboard-client` never determines the human identity. The raw secret,
assertion, and subject are never sent to the frontend or taskctl and are never
stored in D1, logs, or activity payloads. Only the derived actor hash and
ledger/evidence hashes are persisted. A missing signer configuration fails
closed.

The Worker resolves the task's pinned workflow and action, generates the
evidence identity and hash, records a `gate.satisfied` ledger event and outbox
entry, and returns the canonical evidence object with its non-secret scope.
This is an operator-trust boundary: the separate issuer must authenticate the
human before it signs. It can later be replaced by a verified Cloudflare Access
assertion.

The original human may revoke unconsumed or consumed evidence through:

`POST /api/tasks/:id/evidence/:evidenceId/revoke`

Its body contains only a non-PII stable `reason` code. It requires a separate
revocation assertion, bound to the revocation route, task, original evidence
scope (version/workflow/revision/transition/action/gate), evidence ID, reason,
idempotency key, TTL, and nonce. A creation assertion cannot be replayed as a
revocation. Revocation creates a `gate.revoked` ledger event, outbox entry,
activity, and canonical revocation reference atomically.

The transition endpoint resolves every supplied acceptance object against its
persisted record. The record must still be valid, unconsumed, and bound to the
same task, state version, workflow revision, transition, gate, and recorded
human actor. Client-provided UUIDs, hashes, actor labels, or `status: valid`
never establish acceptance. A valid evidence record is consumed by exactly one
successful transition request; all required acceptance gates consume their own
exact record. Idempotent replay of a request returns its original result.
Concurrent ledger writes retry from a fresh head deterministically; a
cross-request idempotency-key collision returns `IDEMPOTENCY_CONFLICT`, not a
partial mutation.

Legacy same-project `PATCH` state changes and `/move` requests are translated
through this service. A cross-project `PATCH` combined with `status` or
`stageId` is rejected with `TRANSITION_REQUIRED`, preventing an unrecorded
completion. A real cross-project move is also rejected with
`PROJECT_MOVE_UNAVAILABLE`: its project-scoped stage mapping would otherwise
change `stageId` outside TransitionService and invalidate the task's immutable
workflow pin. A future project-transfer lifecycle must establish a destination
pin and ledgered projection atomically before that operation can be enabled.

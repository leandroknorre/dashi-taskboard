# Local automation runs

This is local/shared migration `0016_workflow_automation_runs`. It extends the
local `TransitionService` boundary and deliberately does not change Cloud, CLI,
or the UI.

Each successful local transition records exactly one deterministic automation
run for the destination stage. The run is linked to the task, pinned workflow
and revision, physical and contract stage, and immutable transition event. The
run insert happens inside the ledger transaction, so a failed run insert rolls
back the task transition, transition request, ledger event, projection, and
outbox together.

The stage's pinned agent profile supplies the mode:

- `disabled` records a cancelled, effect-free audit entry;
- `manual` records `pending` and waits for an explicit human dispatch;
- `shadow` records a succeeded observation with `effect: none` and is never
  dispatchable.

There is no executor, timer, child process, or automatic adapter delivery in
this slice. Explicit manual dispatch creates one append-only
`workflow_automation_run_outbox` record for a future adapter. The dispatch
response returns an opaque lease token; list and get responses never expose it.
If that lease expires, an explicit human can reclaim the same run with its
current version; this creates a new audited attempt and outbox record without
creating a second run. A retry of an older idempotency key never reveals the
newer lease.

## Local API

- `GET /api/tasks/:taskId/automation-runs`
- `GET /api/automation-runs/:runId`
- `POST /api/automation-runs/:runId/dispatch`
- `POST /api/automation-runs/:runId/result`

Dispatch and result requests require `Idempotency-Key`, optimistic
`expectedVersion`, and (for a result) the active lease token. Only an explicit
human actor can dispatch a manual run: unlike ordinary local mutations, this
route rejects the anonymous `local-user` fallback and requires the
host-provided `X-Taskboard-User-Id` and `X-Taskboard-User-Name` identity
headers. This local/shared slice relies on the hosting boundary to authenticate
and inject those headers; it is not an authorization boundary against an
untrusted process already running on the same host. Results are bounded to 16
KiB and redact sensitive key names before persistence. Run lifecycle records
are append-only: `pending`, `dispatched`, `succeeded`, `failed`, or
`cancelled`.

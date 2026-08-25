# Local TransitionService boundary

This phase adds the local/shared decision layer on top of the approved ledger.
It is intentionally not a Cloud, UI, run-executor, or workflow-authoring
release.

`TransitionService` is the only local path that changes a task's workflow
state. It validates the task's immutable workflow pin, expected state version,
available action, structured gate evidence, exact human authorization, and the
required-descendant completion guard. A successful command writes the task
projection, immutable transition request, ledger event, generic aggregate
projection, and outbox entry in the ledger's one SQLite transaction.

The local migration snapshots each existing stage workflow as revision `1` and
pins existing tasks without adding invented ledger history. The existing
`work_item.imported` baseline remains a projection marker, not an event. New
tasks receive the same baseline marker on insert. New workflow publications use
a new immutable revision; prior tasks retain their original pin. Revision
records, bindings, rules, requests, and pins reject direct mutation.

After a project receives that immutable snapshot, the former physical-stage
editor is explicitly unavailable (`WORKFLOW_AUTHORING_UNAVAILABLE`): deleting
or remapping stages there could bypass a recorded task transition. A later
workflow-authoring release must publish a new revision instead.

The public local entrypoint is:

`POST /api/tasks/:id/transitions`

Its body contains `expectedStateVersion`, `actionKey`, optional
`gateEvidence`, and optional `authorizationId`; it requires an
`Idempotency-Key` header. Repeating the exact request returns the original
effect. Reusing a key for a different command conflicts.

For compatibility, local legacy `PATCH` requests that only change `status` or
`stageId`, and legacy `/move` requests that actually change stage, are
translated to recorded `legacy_move_*` actions. Mixed legacy state and
metadata writes in `PATCH` are rejected so they cannot split one transition
into two writes. A legacy move's thread binding is included in that same atomic
transition for compatibility. Every legacy action still evaluates the gates and
authorization configured by its pinned revision: completion requires valid
human acceptance, and an action configured to require authorization rejects
anything less than an exact active grant. Same-stage ordering remains a
non-transition reorder. Jira-synchronized tasks stay under Jira's existing
path in this local-only phase.

An execution result alone is never accepted as completion, and completing a
parent never moves any parent or sibling automatically. Only a separately
requested transition with valid human acceptance can complete a task.

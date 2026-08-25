# Workflow ledger boundary

This phase supplies durable, append-only storage only. `WorkflowLedger` writes
one canonical event, its generic aggregate projection, and one outbox record in
the same SQLite transaction. It also replays the chain, validates every
denormalized event field, validates the outbox/event correspondence, and checks
the immutable chain head.

Migration 0015 blocks SQLite `INSERT OR REPLACE` before its implicit delete can
replace an existing event. `recursive_triggers` is enabled as extra defense,
but the collision trigger—not a connection-local pragma—is the enforcement
boundary.

`workflow_work_item_projections` is a compatibility projection for pre-existing
tasks. Its `work_item.imported` marker is not a ledger event and must not be
interpreted as historical workflow activity.

No route, UI, run executor, policy evaluator, or `TransitionService` is wired
here. Those layers choose which already-approved event to append later; they do
not rewrite events, projections, or the outbox.

The local schema is applied by `TaskboardDatabase` after the task tables exist.
Cloud applies the equivalent `0014_workflow_ledger.sql` migration. Both retain
legacy tasks and backfill exactly one import projection per task.

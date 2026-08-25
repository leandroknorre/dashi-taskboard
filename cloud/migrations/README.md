# Cloud migration numbering

`0016` is deliberately reserved for the local/server automation-runs schema
(`server/workflow-automation-run-schema.mjs`). It is not a Cloud D1 migration.

Cloud D1 therefore continues from `0015` with `0017_transition_service.sql`,
`0018_human_acceptance_evidence.sql`, and
`0019_thread_host_workspace_privacy.sql`. Keep that visible gap: do not
renumber those published Cloud migrations, even though the Cloud runner applies
only the files in this directory.

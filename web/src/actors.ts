import type { ActorIdentity, AssigneeTarget } from "./types";

export const CODEX_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

/** Non-human assignees generic across any deployment of this project. */
const GENERIC_SESSION_AGENTS: ReadonlyArray<{ id: AssigneeTarget; name: string }> = [
  { id: "claude-agent", name: "Claude ad hoc" },
  { id: "coordenadora-agent", name: "Coordenadora" },
  { id: "dashi-agent", name: "Sessão Dashi" },
];

/**
 * Non-human assignees a card can be dispatched to besides Codex. Each one
 * routes the task to a specific pillar/session rather than a person, so its
 * `id` doubles as the wire-level `AssigneeTarget` the server accepts.
 *
 * The deployment-specific ones (any pillar/business-unit session besides
 * the generic entries above) are never hardcoded here - they come from the
 * server's own TASKBOARD_SESSION_AGENTS configuration, fetched once at
 * startup via `hydrateSessionAgents` (see App.tsx) and spliced in here so
 * this stays the single list every component already reads.
 */
export let SESSION_AGENTS: ReadonlyArray<{ id: AssigneeTarget; name: string }> = [
  { id: CODEX_AGENT_ACTOR.id, name: CODEX_AGENT_ACTOR.name },
  ...GENERIC_SESSION_AGENTS,
];

export let SESSION_AGENT_ACTORS: ReadonlyArray<ActorIdentity> = SESSION_AGENTS.map((agent) => ({
  type: "agent",
  id: agent.id,
  name: agent.name,
  avatarUrl: null,
}));

let sessionAgentActorsById = new Map(SESSION_AGENT_ACTORS.map((actor) => [actor.id, actor]));

/**
 * Replaces the configured (non-generic) session agents with what the server
 * reports for this deployment. Safe to call once at startup - every import
 * of `SESSION_AGENTS`/`SESSION_AGENT_ACTORS` sees the updated list on its
 * next read, since these are live ES module bindings, not a snapshot.
 */
export function hydrateSessionAgents(configuredAgents: ReadonlyArray<{ id: string; name: string }>): void {
  SESSION_AGENTS = [
    { id: CODEX_AGENT_ACTOR.id, name: CODEX_AGENT_ACTOR.name },
    { id: GENERIC_SESSION_AGENTS[0].id, name: GENERIC_SESSION_AGENTS[0].name },
    ...configuredAgents,
    ...GENERIC_SESSION_AGENTS.slice(1),
  ];
  SESSION_AGENT_ACTORS = SESSION_AGENTS.map((agent) => ({
    type: "agent",
    id: agent.id,
    name: agent.name,
    avatarUrl: null,
  }));
  sessionAgentActorsById = new Map(SESSION_AGENT_ACTORS.map((actor) => [actor.id, actor]));
}

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  return sessionAgentActorsById.get(target) ?? currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") {
    return sessionAgentActorsById.has(actor.id) ? (actor.id as AssigneeTarget) : undefined;
  }
  return actor.id === currentUser.id ? "current-user" : undefined;
}

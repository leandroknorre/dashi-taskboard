import type { ActorIdentity, AssigneeTarget } from "./types";

/**
 * Non-human assignees a card can be dispatched to. Each one routes the task
 * to a specific pillar/session rather than a person, so its `id` doubles as
 * the wire-level `AssigneeTarget` the server accepts.
 */
export const SESSION_AGENTS: ReadonlyArray<{ id: AssigneeTarget; name: string }> = [
  { id: "codex-agent", name: "Codex Agent" },
  { id: "claude-agent", name: "Claude ad hoc" },
  { id: "dsadv-agent", name: "Sessão dSAdv" },
  { id: "automatix-agent", name: "Sessão Automatix" },
  { id: "lknorre-agent", name: "Sessão Pessoal/UDV" },
  { id: "bicicleta-agent", name: "Sessão Infra (bicicleta)" },
  { id: "coordenadora-agent", name: "Coordenadora" },
  { id: "dashi-agent", name: "Sessão Dashi" },
];

export const SESSION_AGENT_ACTORS: ReadonlyArray<ActorIdentity> = SESSION_AGENTS.map((agent) => ({
  type: "agent",
  id: agent.id,
  name: agent.name,
  avatarUrl: null,
}));

const SESSION_AGENT_ACTORS_BY_ID = new Map(
  SESSION_AGENT_ACTORS.map((actor) => [actor.id, actor]),
);

export const CODEX_AGENT_ACTOR: ActorIdentity = SESSION_AGENT_ACTORS_BY_ID.get("codex-agent")!;

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  return SESSION_AGENT_ACTORS_BY_ID.get(target) ?? currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") {
    return SESSION_AGENT_ACTORS_BY_ID.has(actor.id) ? (actor.id as AssigneeTarget) : undefined;
  }
  return actor.id === currentUser.id ? "current-user" : undefined;
}

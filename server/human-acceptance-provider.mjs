import { ApiError } from "./database.mjs";

export function validHumanAcceptanceActor(value) {
  return value && value.kind === "human" && typeof value.actorId === "string"
    && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(value.actorId)
    && value.actorId.length <= 128;
}

/**
 * Resolves the human identity from an injected trust boundary. This function
 * intentionally never reads a taskboard user header: public deployments must
 * supply a provider that validates the request upstream.
 */
export function authenticateHumanAcceptance(provider, scope) {
  if (!provider || typeof provider.authenticate !== "function") {
    throw new ApiError(503, "HUMAN_ACCEPTANCE_UNAVAILABLE", "Human acceptance is not configured for this server");
  }
  let result;
  try {
    result = provider.authenticate(scope);
  } catch {
    throw new ApiError(503, "HUMAN_ACCEPTANCE_UNAVAILABLE", "Human acceptance authentication is unavailable");
  }
  if (typeof result?.then === "function") {
    throw new ApiError(503, "HUMAN_ACCEPTANCE_UNAVAILABLE", "Human acceptance authentication must complete before transition application");
  }
  const actor = result?.actor ?? result;
  if (!validHumanAcceptanceActor(actor)) {
    throw new ApiError(403, "HUMAN_ACTOR_REQUIRED", "Human acceptance authentication did not attest a valid human actor");
  }
  return actor;
}

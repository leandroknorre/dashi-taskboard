// Per-pillar access scoping for human identities verified by Cloudflare
// Access (see `proxyAuthenticatedEmail` in app.mjs). Scripts/agents that
// authenticate with an explicit `x-taskboard-user-id` header are never
// scoped here — this only restricts a real person's browser session.
//
// Configuration (both read from the service's own environment, never
// hardcoded — deployment-specific):
//   TASKBOARD_OWNER_EMAIL="leandro@example.com"
//     The one identity that is never restricted. Empty/unset means no
//     identity is treated as the unrestricted owner (current behavior).
//   TASKBOARD_USER_SCOPES="felipe@example.com=automatix,ardelita@example.com=dsadv"
//     Comma-separated `email=pilar` entries, same shape as
//     TASKBOARD_SESSION_AGENTS. A user with more than one pillar joins them
//     with `+`, e.g. "leandro-alt@example.com=dsadv+automatix".
//
// Any authenticated email with NO entry here (and that isn't the owner) is
// denied outright (fail-closed) rather than falling back to full access.

export const OWNER_EMAIL_ENV = "TASKBOARD_OWNER_EMAIL";
export const USER_SCOPES_ENV = "TASKBOARD_USER_SCOPES";
export const PILAR_LABEL_PREFIX = "pilar:";

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PILAR_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function parseConfiguredUserScopes(value) {
  const scopes = new Map();
  if (!value) return scopes;
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separatorIndex = entry.indexOf("=");
    const rawEmail = separatorIndex > 0 ? entry.slice(0, separatorIndex).trim() : "";
    const rawPilares = separatorIndex > 0 ? entry.slice(separatorIndex + 1).trim() : "";
    const email = rawEmail.toLowerCase();
    const pilares = rawPilares.split("+").map((pilar) => pilar.trim()).filter(Boolean);
    const validPilares = pilares.every((pilar) => PILAR_PATTERN.test(pilar));
    if (!EMAIL_PATTERN.test(email) || pilares.length === 0 || !validPilares || scopes.has(email)) {
      console.error(`${USER_SCOPES_ENV}: ignoring invalid entry '${entry}'`);
      continue;
    }
    scopes.set(email, new Set(pilares));
  }
  return scopes;
}

export function normalizeOwnerEmail(value) {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `email` is the already-validated proxy-authenticated email for this
 * request, or null when the request did not carry Cloudflare Access
 * identity (scripts, agents, unauthenticated local dev). Returns:
 *   { restricted: false }                          - no scoping applies
 *   { restricted: true, denied: true, pilares: ∅ }  - unknown identity, fail-closed
 *   { restricted: true, denied: false, pilares }    - scoped to these pillars
 *
 * The whole mechanism stays dormant (current, unscoped behavior) until an
 * operator opts in by setting TASKBOARD_OWNER_EMAIL and/or
 * TASKBOARD_USER_SCOPES - a fresh deploy of this code with neither set
 * never locks anyone out.
 */
export function computeUserScope(email, { ownerEmail, userScopes }) {
  if (!email || (!ownerEmail && userScopes.size === 0)) {
    return { restricted: false, denied: false, pilares: null };
  }
  const normalized = email.toLowerCase();
  if (ownerEmail && normalized === ownerEmail) return { restricted: false, denied: false, pilares: null };
  const pilares = userScopes.get(normalized);
  if (!pilares) return { restricted: true, denied: true, pilares: new Set() };
  return { restricted: true, denied: false, pilares };
}

export function scopeAllowsPilar(scope, pilar) {
  if (!scope.restricted) return true;
  if (scope.denied) return false;
  return pilar !== null && scope.pilares.has(pilar);
}

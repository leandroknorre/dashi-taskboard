export const NESTED_WORKSPACE_DEFAULT_LIMIT = 50;
export const NESTED_WORKSPACE_MAX_LIMIT = 100;
export const NESTED_WORKSPACE_MAX_NODES = 1_000;

export function macroBucketForStatus(status) {
  if (["done", "canceled"].includes(status)) return "closed";
  if (status === "blocked") return "blocked";
  if (status === "in_review") return "review";
  if (status === "in_progress") return "active";
  if (status === "todo") return "ready";
  return "planned";
}

export function workspaceItemFromRow(row, { parentId = null, depth = 0, path = [row.id] } = {}) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    // `status` is the item's actual workflow stage. The macro bucket is a derived view only.
    status: row.status,
    macroBucket: macroBucketForStatus(row.status),
    priority: row.priority,
    archivedAt: row.archived_at,
    // Parent-edge metadata stays on the relation API. Including it here would couple this
    // read model to optional rollups before rollup semantics are part of the contract.
    parentId,
    depth,
    path,
  };
}

export function workspaceOverviewFromTask(task) {
  const {
    relations,
    conversationRefs,
    participants,
    previewImage,
    activityKey,
    activityUpdatedAt,
    ...overview
  } = task;
  return {
    ...overview,
    // Keep the persisted status intact; consumers may use this projection for grouping only.
    macroBucket: macroBucketForStatus(task.status),
  };
}

export function parseNestedWorkspaceQuery(searchParams, createError) {
  const allowed = new Set(["descendants", "limit", "cursor", "childrenCursor", "descendantsCursor"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw createError("UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw createError("INVALID_NESTED_WORKSPACE_QUERY", `Query parameter '${key}' cannot be repeated`);
    }
  }
  const descendants = searchParams.get("descendants") ?? "false";
  if (descendants !== "true" && descendants !== "false") {
    throw createError("INVALID_NESTED_WORKSPACE_QUERY", "'descendants' must be true or false");
  }
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? NESTED_WORKSPACE_DEFAULT_LIMIT : Number(rawLimit);
  if (
    !/^\d+$/.test(rawLimit ?? String(NESTED_WORKSPACE_DEFAULT_LIMIT))
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > NESTED_WORKSPACE_MAX_LIMIT
  ) {
    throw createError(
      "INVALID_NESTED_WORKSPACE_QUERY",
      `'limit' must be an integer from 1 to ${NESTED_WORKSPACE_MAX_LIMIT}`,
    );
  }
  const parseCursor = (value, kind, name) => {
    if (value === null) return null;
    const prefix = `workspace:${kind}:`;
    if (!value.startsWith(prefix) || value.length <= prefix.length) {
      throw createError(
        "INVALID_NESTED_WORKSPACE_CURSOR",
        `'${name}' must be a ${kind} workspace cursor`,
      );
    }
    return value;
  };
  let childrenCursor = parseCursor(searchParams.get("childrenCursor"), "children", "childrenCursor");
  let descendantsCursor = parseCursor(
    searchParams.get("descendantsCursor"),
    "descendants",
    "descendantsCursor",
  );
  const legacyCursor = searchParams.get("cursor");
  if (legacyCursor !== null) {
    const match = /^workspace:(children|descendants):.+$/.exec(legacyCursor);
    if (!match) {
      throw createError(
        "INVALID_NESTED_WORKSPACE_CURSOR",
        "'cursor' is ambiguous; use 'childrenCursor' or 'descendantsCursor'",
      );
    }
    if (match[1] === "children" && childrenCursor === null) childrenCursor = legacyCursor;
    else if (match[1] === "descendants" && descendantsCursor === null) descendantsCursor = legacyCursor;
    else throw createError("INVALID_NESTED_WORKSPACE_CURSOR", "Workspace cursor is repeated");
  }
  if (!descendants && descendantsCursor !== null) {
    throw createError(
      "INVALID_NESTED_WORKSPACE_CURSOR",
      "'descendantsCursor' requires 'descendants=true'",
    );
  }
  return { descendants: descendants === "true", limit, childrenCursor, descendantsCursor };
}

export function paginateWorkspaceItems(items, cursor, limit, kind, createError) {
  let start = 0;
  if (cursor) {
    const lastId = cursor.slice(`workspace:${kind}:`.length);
    const index = items.findIndex((item) => item.id === lastId);
    if (index === -1) {
      throw createError("INVALID_NESTED_WORKSPACE_CURSOR", "'cursor' does not belong to this workspace");
    }
    start = index + 1;
  }
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + page.length < items.length && page.length > 0
      ? `workspace:${kind}:${page.at(-1).id}`
      : null,
  };
}

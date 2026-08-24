export const DEFAULT_PARENT_RELATION_METADATA = Object.freeze({
  required: true,
  rollup: true,
});

export const DEFAULT_PARENT_RELATION_METADATA_JSON = JSON.stringify(
  DEFAULT_PARENT_RELATION_METADATA,
);

function copyDefault() {
  return { ...DEFAULT_PARENT_RELATION_METADATA };
}

export function normalizeParentRelationMetadata(value, { required = false } = {}) {
  if (value === undefined) {
    if (!required) return copyDefault();
    throw new TypeError("'metadata' is required");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("'metadata' must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !["required", "rollup"].includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown metadata field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  if (typeof value.required !== "boolean" || typeof value.rollup !== "boolean") {
    throw new TypeError("'metadata.required' and 'metadata.rollup' must be booleans");
  }
  return { required: value.required, rollup: value.rollup };
}

export function parentRelationMetadataJson(value, options) {
  return JSON.stringify(normalizeParentRelationMetadata(value, options));
}

export function parentRelationMetadataFromStored(value) {
  if (typeof value !== "string") return copyDefault();
  try {
    return normalizeParentRelationMetadata(JSON.parse(value));
  } catch {
    return copyDefault();
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateTaskRollup,
  rollupAffectedAncestorIds,
} from "../shared/task-rollup.mjs";

function task(id, overrides = {}) {
  return {
    id,
    status: "todo",
    priority: "none",
    archivedAt: null,
    version: 1,
    updatedAt: `2026-08-24T00:00:0${id.length}.000Z`,
    ...overrides,
  };
}

test("rollup is structural, deterministic, and keeps the parent's manual stage separate", () => {
  const root = task("root", { status: "in_review" });
  const child = task("child", { status: "done", priority: "urgent", version: 2 });
  const blocked = task("blocked", { status: "blocked", priority: "urgent", version: 3 });
  const ignored = task("ignored", { status: "blocked", priority: "urgent" });
  const rollup = calculateTaskRollup({
    root,
    tasks: [root, child, blocked, ignored],
    relations: [
      { type: "parent", parentId: "root", childId: "child", metadata: { rollup: true } },
      { type: "parent", parentId: "child", childId: "blocked", metadata: { rollup: true } },
      { type: "parent", parentId: "root", childId: "ignored", metadata: { rollup: false } },
      { type: "blocks", parentId: "root", childId: "ignored", metadata: { rollup: true } },
    ],
  });

  assert.equal(rollup.stage, "in_review");
  assert.deepEqual(rollup.progress, { total: 2, completed: 1, terminal: 1 });
  assert.deepEqual(rollup.visual, { state: "blocked", sourceTaskIds: ["blocked"] });
  assert.equal(rollup.freshness.stale, false);
  assert.equal(rollup.provenance.kind, "structural-parent");
  assert.deepEqual(rollup.provenance.sourceTaskIds, ["child", "blocked"]);
  assert.match(rollup.freshness.sourceRevision, /blocked:3:/);
  assert.doesNotMatch(rollup.freshness.sourceRevision, /ignored/);
});

test("rollup invalidation is limited to rollup-enabled ancestors", () => {
  const relations = [
    { type: "parent", parentId: "root", childId: "middle", metadata: { rollup: true } },
    { type: "parent", parentId: "middle", childId: "leaf", metadata: { rollup: true } },
    { type: "parent", parentId: "unrelated", childId: "other", metadata: { rollup: true } },
    { type: "parent", parentId: "hidden", childId: "leaf", metadata: { rollup: false } },
    { type: "blocks", parentId: "lateral", childId: "leaf", metadata: { rollup: true } },
  ];
  assert.deepEqual(rollupAffectedAncestorIds("leaf", relations), ["middle", "root"]);
});

test("rollup preserves the existing task-tree node limit", () => {
  const root = task("root");
  const first = task("first");
  const second = task("second");
  assert.doesNotThrow(() => calculateTaskRollup({
    root,
    tasks: [root, first, second],
    relations: [
      { type: "parent", parentId: "root", childId: "first" },
      { type: "parent", parentId: "first", childId: "second" },
    ],
    maxNodes: 3,
  }));
  assert.throws(() => calculateTaskRollup({
    root,
    tasks: [root, first, second, task("third")],
    relations: [
      { type: "parent", parentId: "root", childId: "first" },
      { type: "parent", parentId: "first", childId: "second" },
      { type: "parent", parentId: "second", childId: "third" },
    ],
    maxNodes: 3,
  }), /cannot exceed 3 nodes/);
});

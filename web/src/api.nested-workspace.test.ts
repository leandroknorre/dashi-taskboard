import { afterEach, describe, expect, it, vi } from "vitest";
import { getNestedWorkspace } from "./api";

afterEach(() => vi.unstubAllGlobals());

function mockWorkspaceFetch() {
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    workspace: { overview: {}, breadcrumb: [], children: { items: [], nextCursor: null } },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("getNestedWorkspace", () => {
  it("uses the children-scoped cursor without serializing a legacy cursor", async () => {
    const fetch = mockWorkspaceFetch();
    await getNestedWorkspace("TASK/1", { childrenCursor: "workspace:children:child-a" });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/tasks/TASK%2F1/workspace");
    expect(url.searchParams.get("childrenCursor")).toBe("workspace:children:child-a");
    expect(url.searchParams.has("descendantsCursor")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("keeps descendants pagination independently scoped", async () => {
    const fetch = mockWorkspaceFetch();
    await getNestedWorkspace("TASK-1", {
      descendants: true,
      childrenCursor: "workspace:children:child-a",
      descendantsCursor: "workspace:descendants:descendant-a",
    });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("descendants")).toBe("true");
    expect(url.searchParams.get("childrenCursor")).toBe("workspace:children:child-a");
    expect(url.searchParams.get("descendantsCursor")).toBe("workspace:descendants:descendant-a");
    expect(url.searchParams.has("cursor")).toBe(false);
  });
});

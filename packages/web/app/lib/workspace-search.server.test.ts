import { expect, it, vi } from "vitest";
import { searchAsWorkspaceMember } from "./workspace-search.server";

const record = vi.hoisted(() => vi.fn());
vi.mock("@doco/db", () => ({ getWorkspaceRole: async () => null, recordQueryEvent: record }));

it("a valid session without workspace membership cannot consume the workspace's query allowance", async () => {
  expect(
    await searchAsWorkspaceMember({
      source: "ui",
      workspaceId: "one",
      userId: "former-member",
      query: "docs",
    }),
  ).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});

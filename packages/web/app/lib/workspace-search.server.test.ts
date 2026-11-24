import { expect, it, vi } from "vitest";
import { searchAsWorkspaceMember } from "./workspace-search.server";

vi.mock("@doco/db", () => ({ getWorkspaceRole: async () => null }));
const meter = vi.hoisted(() => vi.fn());
vi.mock("@doco/host", () => ({ measureWorkspaceQuery: meter }));

it("a valid session without workspace membership cannot consume the workspace's query allowance", async () => {
  expect(
    await searchAsWorkspaceMember({ workspaceId: "one", userId: "former-member", query: "docs" }),
  ).toEqual([]);
  expect(meter).not.toHaveBeenCalled();
});

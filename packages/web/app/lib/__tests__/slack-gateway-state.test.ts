import { describe, expect, it } from "vitest";
import { createPluginGatewayState, verifyPluginGatewayState } from "../plugin-gateway-state.server";

describe("Open Braino Slack gateway state", () => {
  it("binds the callback to this owner and workspace for ten minutes", () => {
    const state = createPluginGatewayState(
      { provider: "slack", userId: "user_owner", workspaceId: "workspace_meta" },
      "instance-secret",
      1_000,
    );

    expect(verifyPluginGatewayState(state, "slack", "instance-secret", 1_500)).toEqual({
      userId: "user_owner",
      workspaceId: "workspace_meta",
    });
    expect(() => verifyPluginGatewayState(state, "slack", "wrong-secret", 1_500)).toThrow(
      "Plugin gateway state is invalid.",
    );
    expect(() =>
      verifyPluginGatewayState(state, "slack", "instance-secret", 11 * 60 * 1000),
    ).toThrow("Plugin gateway state expired.");
  });
});

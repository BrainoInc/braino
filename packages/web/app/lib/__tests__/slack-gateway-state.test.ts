import { describe, expect, it } from "vitest";
import { createSlackGatewayState, verifySlackGatewayState } from "../slack-gateway-state.server";

describe("Open Braino Slack gateway state", () => {
  it("binds the callback to this owner and workspace for ten minutes", () => {
    const state = createSlackGatewayState(
      { userId: "user_owner", workspaceId: "workspace_meta" },
      "instance-secret",
      1_000,
    );

    expect(verifySlackGatewayState(state, "instance-secret", 1_500)).toEqual({
      userId: "user_owner",
      workspaceId: "workspace_meta",
    });
    expect(() => verifySlackGatewayState(state, "wrong-secret", 1_500)).toThrow(
      "Slack gateway state is invalid.",
    );
    expect(() => verifySlackGatewayState(state, "instance-secret", 11 * 60 * 1000)).toThrow(
      "Slack gateway state expired.",
    );
  });
});

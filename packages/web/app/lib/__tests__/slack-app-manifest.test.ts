import { describe, expect, it } from "vitest";
import { slackAppBootstrapManifest, slackAppManifest } from "../slack-app-manifest";

describe("instance-local Señor Braino Slack app manifest", () => {
  it("points Slack directly at this instance with the assistant-only scopes", () => {
    const manifest = slackAppManifest("https://meta.braino.dev/");

    expect(manifest.display_information.name).toBe("Señor Braino");
    expect(manifest.features.bot_user.display_name).toBe("Señor Braino");
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://meta.braino.dev/api/v1/plugins/slack/events",
    );
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "app_mention",
      "message.im",
      "app_uninstalled",
      "tokens_revoked",
    ]);
    expect(manifest.oauth_config.scopes.bot).toEqual([
      "app_mentions:read",
      "channels:join",
      "channels:read",
      "chat:write",
      "im:history",
      "users:read",
      "users:read.email",
    ]);
    expect(manifest.oauth_config.scopes.bot).not.toContain("channels:history");
  });

  it("bootstraps without an Events API challenge before Braino has the signing secret", () => {
    expect(slackAppBootstrapManifest().settings).not.toHaveProperty("event_subscriptions");
  });
});

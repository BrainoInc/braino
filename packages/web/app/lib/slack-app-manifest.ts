const SLACK_EVENTS_PATH = "/api/v1/plugins/slack/events";

export function slackAppManifest(origin: string) {
  const requestUrl = new URL(SLACK_EVENTS_PATH, origin).toString();

  return {
    display_information: {
      name: "Señor Braino",
      description: "Ask your Braino workspace from Slack.",
      background_color: "#9e3fae",
    },
    features: {
      bot_user: {
        display_name: "Señor Braino",
        always_online: true,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:join",
          "channels:read",
          "chat:write",
          "im:history",
          "users:read",
          "users:read.email",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: ["app_mention", "message.im", "app_uninstalled", "tokens_revoked"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  } as const;
}

/** The first manifest omits Events API settings so Slack does not challenge an unconnected app. */
export function slackAppBootstrapManifest() {
  const { settings: _settings, ...manifest } = slackAppManifest("https://example.invalid");
  return {
    ...manifest,
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  } as const;
}

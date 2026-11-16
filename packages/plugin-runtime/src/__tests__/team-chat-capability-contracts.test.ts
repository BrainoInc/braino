import { describe, expect, it } from "vitest";
import {
  PluginContractError,
  parseTeamChatCapabilityInput,
  parseTeamChatCapabilityOutput,
} from "../index.js";

describe("team-chat capability contracts", () => {
  it("normalizes the provider-neutral connect, event, and send inputs", () => {
    expect(
      parseTeamChatCapabilityInput("team_chat.connect", {
        installer: { email: " owner@example.com " },
        introductionChannel: " general ",
      }),
    ).toEqual({
      installer: { email: "owner@example.com" },
      introductionChannel: "general",
    });

    expect(
      parseTeamChatCapabilityInput("event.receive", {
        body: '{"type":"event_callback"}',
        headers: { "X-Slack-Signature": " v0=abc ", "X-Slack-Request-Timestamp": "123" },
        receivedAt: 456,
      }),
    ).toEqual({
      body: '{"type":"event_callback"}',
      headers: { "x-slack-request-timestamp": "123", "x-slack-signature": "v0=abc" },
      receivedAt: 456,
    });

    expect(
      parseTeamChatCapabilityInput("team_chat.send", {
        target: { kind: "channel", id: " C123 " },
        text: " Hello ",
        threadId: " 171.2 ",
      }),
    ).toEqual({
      target: { kind: "channel", id: "C123" },
      text: "Hello",
      threadId: "171.2",
    });
  });

  it("normalizes connect metadata, inbound events, and sent-message receipts", () => {
    expect(
      parseTeamChatCapabilityOutput(
        "team_chat.connect",
        {
          externalWorkspaceId: " T123 ",
          workspaceName: " Acme ",
          botUserId: " U-BOT ",
          installerUserId: " U-OWNER ",
          channels: [{ id: " C1 ", name: " general " }],
        },
        {},
      ),
    ).toEqual({
      externalWorkspaceId: "T123",
      workspaceName: "Acme",
      botUserId: "U-BOT",
      installerUserId: "U-OWNER",
      channels: [{ id: "C1", name: "general" }],
    });

    expect(
      parseTeamChatCapabilityOutput(
        "event.receive",
        [
          {
            id: " Ev1 ",
            occurredAt: "2026-11-16T04:00:00.000Z",
            kind: "team_chat.message",
            data: {
              channelId: "C1",
              senderId: "U1",
              senderEmail: " reader@example.com ",
              text: "What changed?",
              messageId: "171.1",
              replyThreadId: "171.1",
              direct: false,
            },
          },
        ],
        {},
      ),
    ).toEqual([
      {
        id: "Ev1",
        occurredAt: "2026-11-16T04:00:00.000Z",
        kind: "team_chat.message",
        data: {
          channelId: "C1",
          senderId: "U1",
          senderEmail: "reader@example.com",
          text: "What changed?",
          messageId: "171.1",
          replyThreadId: "171.1",
          direct: false,
        },
      },
    ]);

    expect(
      parseTeamChatCapabilityOutput(
        "team_chat.send",
        { externalId: " 171.3 " },
        { target: { kind: "channel", id: "C1" }, text: "Hello" },
      ),
    ).toEqual({ externalId: "171.3" });
  });

  it("rejects malformed provider data at the host boundary", () => {
    expect(() =>
      parseTeamChatCapabilityInput("team_chat.send", {
        target: { kind: "workspace", id: "T1" },
        text: "Hello",
      }),
    ).toThrow(PluginContractError);
    expect(() =>
      parseTeamChatCapabilityInput("event.receive", {
        body: "{}",
        headers: {},
        receivedAt: -1,
      }),
    ).toThrow("receivedAt");
    expect(() =>
      parseTeamChatCapabilityOutput(
        "event.receive",
        [{ id: "event", occurredAt: "not-a-date", kind: "team_chat.message", data: {} }],
        {},
      ),
    ).toThrow("occurredAt");
    expect(() =>
      parseTeamChatCapabilityOutput(
        "event.receive",
        [
          {
            id: "event",
            occurredAt: "2026-11-16T04:00:00.000Z",
            kind: "team_chat.message",
            data: { channelId: "C1", senderId: "U1", text: "Question", messageId: "1" },
          },
        ],
        {},
      ),
    ).toThrow("senderEmail");
  });

  it("keeps optional fields optional and normalizes every supported event shape", () => {
    expect(parseTeamChatCapabilityInput("team_chat.connect", {})).toEqual({});
    expect(parseTeamChatCapabilityInput("team_chat.connect", { installer: {} })).toEqual({
      installer: {},
    });
    expect(
      parseTeamChatCapabilityInput("team_chat.send", {
        target: { kind: "user", id: " U1 " },
        text: " Hello ",
      }),
    ).toEqual({ target: { kind: "user", id: "U1" }, text: "Hello" });

    expect(
      parseTeamChatCapabilityOutput(
        "team_chat.connect",
        {
          externalWorkspaceId: "T1",
          workspaceName: "Acme",
          botUserId: "U-BOT",
          channels: [],
        },
        {},
      ),
    ).toEqual({
      externalWorkspaceId: "T1",
      workspaceName: "Acme",
      botUserId: "U-BOT",
      channels: [],
    });

    expect(
      parseTeamChatCapabilityOutput(
        "event.receive",
        [
          {
            id: "challenge-1",
            occurredAt: "1794808800",
            kind: "webhook.challenge",
            data: { challenge: " verify-me " },
          },
          {
            id: "uninstalled-1",
            occurredAt: "2026-11-16T06:00:00.000Z",
            kind: "team_chat.uninstalled",
            data: {},
          },
          {
            id: "provider-event-1",
            occurredAt: "2026-11-16T06:00:00.000Z",
            kind: "provider.custom",
            data: { providerField: true },
          },
          {
            id: "message-1",
            occurredAt: "2026-11-16T06:00:00.000Z",
            kind: "team_chat.message",
            data: {
              channelId: "D1",
              senderId: "U1",
              senderEmail: "OWNER@EXAMPLE.COM",
              text: "Hello",
              messageId: "1",
              direct: true,
            },
          },
        ],
        {},
      ),
    ).toEqual([
      {
        id: "challenge-1",
        occurredAt: "2026-11-16T06:00:00.000Z",
        kind: "webhook.challenge",
        data: { challenge: "verify-me" },
      },
      {
        id: "uninstalled-1",
        occurredAt: "2026-11-16T06:00:00.000Z",
        kind: "team_chat.uninstalled",
        data: {},
      },
      {
        id: "provider-event-1",
        occurredAt: "2026-11-16T06:00:00.000Z",
        kind: "provider.custom",
        data: { providerField: true },
      },
      {
        id: "message-1",
        occurredAt: "2026-11-16T06:00:00.000Z",
        kind: "team_chat.message",
        data: {
          channelId: "D1",
          senderId: "U1",
          senderEmail: "owner@example.com",
          text: "Hello",
          messageId: "1",
          direct: true,
        },
      },
    ]);
  });

  it.each([
    ["object", () => parseTeamChatCapabilityInput("team_chat.connect", [])],
    [
      "unknown field",
      () => parseTeamChatCapabilityInput("team_chat.connect", { unsupported: true }),
    ],
    [
      "body",
      () =>
        parseTeamChatCapabilityInput("event.receive", {
          body: {},
          headers: {},
          receivedAt: 1,
        }),
    ],
    [
      "Header",
      () =>
        parseTeamChatCapabilityInput("event.receive", {
          body: "{}",
          headers: { broken: " " },
          receivedAt: 1,
        }),
    ],
    [
      "receivedAt",
      () =>
        parseTeamChatCapabilityInput("event.receive", {
          body: "{}",
          headers: {},
          receivedAt: 1.5,
        }),
    ],
    [
      "channels",
      () =>
        parseTeamChatCapabilityOutput(
          "team_chat.connect",
          {
            externalWorkspaceId: "T1",
            workspaceName: "Acme",
            botUserId: "U-BOT",
            channels: {},
          },
          {},
        ),
    ],
    [
      "senderEmail",
      () =>
        parseTeamChatCapabilityOutput(
          "event.receive",
          [
            {
              id: "event",
              occurredAt: "2026-11-16T04:00:00.000Z",
              kind: "team_chat.message",
              data: {
                channelId: "C1",
                senderId: "U1",
                senderEmail: "not-an-email",
                text: "Question",
                messageId: "1",
                direct: false,
              },
            },
          ],
          {},
        ),
    ],
    [
      "direct",
      () =>
        parseTeamChatCapabilityOutput(
          "event.receive",
          [
            {
              id: "event",
              occurredAt: "2026-11-16T04:00:00.000Z",
              kind: "team_chat.message",
              data: {
                channelId: "C1",
                senderId: "U1",
                senderEmail: "owner@example.com",
                text: "Question",
                messageId: "1",
                direct: "yes",
              },
            },
          ],
          {},
        ),
    ],
    ["array", () => parseTeamChatCapabilityOutput("event.receive", {}, {})],
  ])("rejects invalid %s contract data", (message, operation) => {
    expect(operation).toThrow(message);
  });
});

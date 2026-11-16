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
});

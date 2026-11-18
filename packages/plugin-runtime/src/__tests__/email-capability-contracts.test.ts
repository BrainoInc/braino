import { describe, expect, it } from "vitest";
import {
  EMAIL_CAPABILITY_CONTRACT_VERSIONS,
  type PluginContractError,
  parseEmailCapabilityInput,
  parseEmailCapabilityOutput,
} from "../index.js";

describe("email capability contracts", () => {
  it("defines one provider-neutral email contract", () => {
    expect(EMAIL_CAPABILITY_CONTRACT_VERSIONS).toEqual({ "email.send": 1 });
    expect(
      parseEmailCapabilityInput("email.send", {
        to: [" person@example.com "],
        subject: " Welcome ",
        html: "<p>Hello</p>",
        replyTo: [" support@example.com "],
      }),
    ).toEqual({
      to: ["person@example.com"],
      subject: "Welcome",
      html: "<p>Hello</p>",
      replyTo: ["support@example.com"],
    });
  });

  it("accepts text, HTML, or both and canonicalizes the delivery receipt", () => {
    const request = parseEmailCapabilityInput("email.send", {
      to: ["person@example.com"],
      subject: "Hello",
      text: "Plain text",
      html: "<p>Rich text</p>",
    });
    expect(
      parseEmailCapabilityOutput("email.send", { externalId: " email_123 " }, request),
    ).toEqual({ externalId: "email_123" });
  });

  it.each([
    [{ to: [], subject: "Hello", text: "Body" }, "recipient"],
    [{ to: ["not-an-email"], subject: "Hello", text: "Body" }, "recipient"],
    [{ to: ["person@example.com"], subject: "", text: "Body" }, "subject"],
    [{ to: ["person@example.com"], subject: "Hello" }, "text or HTML"],
    [
      { to: ["person@example.com"], subject: "Hello", text: "Body", from: "x@example.com" },
      "unknown",
    ],
  ])("rejects malformed email input", (input, message) => {
    expect(() => parseEmailCapabilityInput("email.send", input)).toThrow(
      expect.objectContaining<Partial<PluginContractError>>({
        name: "PluginContractError",
        message: expect.stringContaining(message),
      }),
    );
  });

  it("rejects malformed provider output", () => {
    expect(() =>
      parseEmailCapabilityOutput(
        "email.send",
        { externalId: "" },
        { to: ["person@example.com"], subject: "Hello", text: "Body" },
      ),
    ).toThrow("externalId");
  });
});

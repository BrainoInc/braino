import { describe, expect, it } from "vitest";
import {
  MODEL_CAPABILITY_CONTRACT_VERSIONS,
  type PluginContractError,
  parseModelCapabilityInput,
  parseModelCapabilityOutput,
} from "../index.js";

describe("model capability contracts", () => {
  it("versions chat and embedding independently from provider implementations", () => {
    expect(MODEL_CAPABILITY_CONTRACT_VERSIONS).toEqual({
      "chat.complete": 1,
      "embedding.embed": 1,
    });
  });

  it("accepts the provider-neutral chat v1 contract", () => {
    const request = parseModelCapabilityInput("chat.complete", {
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "What is Braino?" },
      ],
      responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    });

    expect(request).toEqual({
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "What is Braino?" },
      ],
      responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    });
    expect(
      parseModelCapabilityOutput(
        "chat.complete",
        { content: '{"answer":"Shared memory."}', model: "provider:model" },
        request,
      ),
    ).toEqual({ content: '{"answer":"Shared memory."}', model: "provider:model" });
  });

  it.each([
    [{ messages: [] }, "messages"],
    [{ messages: [{ role: "provider", content: "no" }] }, "role"],
    [{ messages: [{ role: "user", content: " " }] }, "content"],
    [{ messages: [{ role: "user", content: "hello" }], model: "gpt-provider-knob" }, "unknown"],
    [{ messages: [{ role: "user", content: "hello" }], responseSchema: [] }, "responseSchema"],
  ])("rejects a non-canonical chat request", (request, message) => {
    expect(() => parseModelCapabilityInput("chat.complete", request)).toThrow(
      expect.objectContaining<Partial<PluginContractError>>({
        name: "PluginContractError",
        message: expect.stringContaining(message),
      }),
    );
  });

  it.each([
    [{ content: "", model: "provider:model" }, "content"],
    [{ content: "answer", model: "" }, "model"],
    [{ content: "answer", model: "provider:model", usage: {} }, "unknown"],
  ])("rejects a non-canonical chat response", (response, message) => {
    expect(() =>
      parseModelCapabilityOutput(
        "chat.complete",
        response,
        parseModelCapabilityInput("chat.complete", {
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    ).toThrow(message);
  });

  it("validates embedding output against the corresponding request", () => {
    const request = parseModelCapabilityInput("embedding.embed", {
      inputs: ["first", "second"],
      inputType: "document",
    });

    expect(
      parseModelCapabilityOutput(
        "embedding.embed",
        {
          model: "provider:embedding-model",
          dimensions: 2,
          vectors: [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
        },
        request,
      ),
    ).toEqual({
      model: "provider:embedding-model",
      dimensions: 2,
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });
  });

  it.each([
    [{ inputs: [] }, "inputs"],
    [{ inputs: [" "] }, "inputs"],
    [{ inputs: ["hello"], inputType: "other" }, "inputType"],
    [{ inputs: ["hello"], model: "provider-knob" }, "unknown"],
  ])("rejects a non-canonical embedding request", (request, message) => {
    expect(() => parseModelCapabilityInput("embedding.embed", request)).toThrow(message);
  });

  it.each([
    [
      { model: "provider:model", dimensions: 2, vectors: [[0.1, 0.2]] },
      ["first", "second"],
      "count",
    ],
    [{ model: "provider:model", dimensions: 2, vectors: [[0.1]] }, ["first"], "dimensions"],
    [{ model: "provider:model", dimensions: 2, vectors: [[0.1, Number.NaN]] }, ["first"], "finite"],
  ])("rejects embedding output that violates its request", (response, inputs, message) => {
    expect(() =>
      parseModelCapabilityOutput(
        "embedding.embed",
        response,
        parseModelCapabilityInput("embedding.embed", { inputs }),
      ),
    ).toThrow(message);
  });
});

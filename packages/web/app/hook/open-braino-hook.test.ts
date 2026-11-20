import { afterEach, describe, expect, it, vi } from "vitest";
// The hook is a dependency-free script shared by every supported agent client.
// @ts-expect-error JavaScript entrypoints intentionally ship without declarations.
import { main } from "../../../../.doco/hook.mjs";

describe("Open Braino hook transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the instance MCP brief when hosted HTTP hook routes are absent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "https://meta.braino.dev/mcp") {
          return Response.json({
            jsonrpc: "2.0",
            id: "braino-hook",
            result: {
              content: [{ type: "text", text: "Meta brief: keep the instance siloed." }],
              structuredContent: { brief_id: "brief_meta" },
            },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const output = await main(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "meta-hook-test",
        cwd: process.cwd(),
        prompt: "Reconfigure the project hook",
      }),
      {
        ...process.env,
        DOCO_ORIGIN: "https://meta.braino.dev",
        DOCO_TOKEN: "doco_at_meta",
        DOCO_WORKSPACE: "meta-braino",
      },
      process.cwd(),
    );

    expect(JSON.parse(output ?? "null")).toMatchObject({
      hookSpecificOutput: {
        additionalContext: expect.stringContaining("Meta brief: keep the instance siloed."),
      },
    });
    const mcp = calls.find((call) => call.url === "https://meta.braino.dev/mcp");
    expect(mcp?.init?.method).toBe("POST");
    expect(mcp?.init?.headers).toMatchObject({ Authorization: "Bearer doco_at_meta" });
    expect(JSON.parse(String(mcp?.init?.body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "doco_brief",
        arguments: { about: "Reconfigure the project hook" },
      },
    });
  });
});

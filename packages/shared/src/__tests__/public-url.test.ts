import { afterEach, describe, expect, it } from "vitest";
import { getPublicBaseUrl } from "../public-url.js";

const original = process.env.BRAINO_PUBLIC_HOST;

afterEach(() => {
  if (original === undefined) process.env.BRAINO_PUBLIC_HOST = undefined;
  else process.env.BRAINO_PUBLIC_HOST = original;
});

describe("getPublicBaseUrl", () => {
  it("returns scheme://host from the request when BRAINO_PUBLIC_HOST is unset", () => {
    process.env.BRAINO_PUBLIC_HOST = undefined;
    const req = new Request("http://127.0.0.1:5173/some/path?q=1");
    expect(getPublicBaseUrl(req)).toBe("http://127.0.0.1:5173");
  });

  it("honors BRAINO_PUBLIC_HOST when set, ignoring the request host", () => {
    process.env.BRAINO_PUBLIC_HOST = "https://braino.dev";
    const req = new Request("http://127.0.0.1:5173/anything");
    expect(getPublicBaseUrl(req)).toBe("https://braino.dev");
  });

  it("strips a trailing slash from BRAINO_PUBLIC_HOST", () => {
    process.env.BRAINO_PUBLIC_HOST = "https://braino.dev/";
    const req = new Request("http://127.0.0.1:5173/");
    expect(getPublicBaseUrl(req)).toBe("https://braino.dev");
  });

  it("preserves a non-trailing path segment in BRAINO_PUBLIC_HOST (sub-path tunneling)", () => {
    process.env.BRAINO_PUBLIC_HOST = "https://tunnel.example.com/braino";
    const req = new Request("http://127.0.0.1:5173/");
    expect(getPublicBaseUrl(req)).toBe("https://tunnel.example.com/braino");
  });

  it("works with https requests when BRAINO_PUBLIC_HOST is unset", () => {
    process.env.BRAINO_PUBLIC_HOST = undefined;
    const req = new Request("https://example.com:8443/x");
    expect(getPublicBaseUrl(req)).toBe("https://example.com:8443");
  });

  it("ignores empty BRAINO_PUBLIC_HOST (treats as unset)", () => {
    process.env.BRAINO_PUBLIC_HOST = "";
    const req = new Request("http://127.0.0.1:5173/y");
    expect(getPublicBaseUrl(req)).toBe("http://127.0.0.1:5173");
  });
});

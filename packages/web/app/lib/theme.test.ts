import { describe, expect, it } from "vitest";
import { themeCookie, themeFromRequest } from "./theme";

describe("workspace theme", () => {
  it("follows the computer until a valid theme is saved", () => {
    expect(themeFromRequest(new Request("https://meta.braino.dev/"))).toBe("auto");
    expect(
      themeFromRequest(
        new Request("https://meta.braino.dev/", {
          headers: { cookie: "another=value; braino_theme=dark" },
        }),
      ),
    ).toBe("dark");
    expect(
      themeFromRequest(
        new Request("https://meta.braino.dev/", {
          headers: { cookie: "braino_theme=unsupported" },
        }),
      ),
    ).toBe("auto");
  });

  it("persists a selection for every page", () => {
    expect(themeCookie("light")).toBe("braino_theme=light; Path=/; Max-Age=31536000; SameSite=Lax");
  });
});

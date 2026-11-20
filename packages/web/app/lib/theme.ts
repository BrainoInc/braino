export const THEMES = ["light", "dark", "auto"] as const;
export type Theme = (typeof THEMES)[number];

const THEME_COOKIE = "braino_theme";

export function themeFromRequest(request: Request): Theme {
  const saved = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim().split("="))
    .find(([name]) => name === THEME_COOKIE)?.[1];
  return THEMES.find((theme) => theme === saved) ?? "auto";
}

export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

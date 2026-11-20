import { msg } from "@doco/shared/i18n";
import { useT } from "@doco/shared/i18n/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useRef, useState } from "react";
import { useRouteLoaderData } from "react-router";
import { THEMES, type Theme, themeCookie } from "~/lib/theme";

const ICON = { light: Sun, dark: Moon, auto: Monitor };
const LABEL = {
  light: msg("Light"),
  dark: msg("Dark"),
  auto: msg("Auto, as your computer is set"),
};

export function ThemeMenu() {
  const t = useT();
  const root = useRouteLoaderData("root") as { theme?: Theme } | undefined;
  const [theme, setTheme] = useState<Theme>(root?.theme ?? "auto");
  const menu = useRef<HTMLDetailsElement>(null);
  const pick = (next: Theme) => {
    document.cookie = themeCookie(next);
    document.documentElement.dataset.theme = next;
    setTheme(next);
    if (menu.current) menu.current.open = false;
  };
  const Current = ICON[theme];
  return (
    <details ref={menu} className="relative">
      <summary
        className="neu-button flex cursor-pointer list-none items-center rounded-md px-2.5 py-1.5"
        aria-label={t("Theme")}
        title={t("Theme")}
      >
        <Current size={16} aria-hidden="true" />
      </summary>
      <ul className="neu-surface absolute end-0 z-10 mt-2 w-max rounded-md bg-card p-1">
        {THEMES.map((option) => {
          const Icon = ICON[option];
          return (
            <li key={option}>
              <button
                type="button"
                aria-pressed={theme === option}
                onClick={() => pick(option)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-start text-sm hover:bg-muted aria-pressed:shadow-(--neu-pressed)"
              >
                <Icon size={14} aria-hidden="true" />
                {t(LABEL[option])}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

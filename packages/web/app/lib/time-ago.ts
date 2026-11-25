import type { Translator } from "@braino/shared/i18n";
import type { ReactTranslator } from "@braino/shared/i18n/react";

export function timeAgo(
  t: Translator | ReactTranslator,
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const ms = now.getTime() - then.getTime();
  if (Number.isNaN(ms)) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t("just now");
  const ago = new Intl.RelativeTimeFormat(t.locale, { numeric: "always", style: "narrow" });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ago.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return ago.format(-days, "day");
  const months = Math.floor(days / 30);
  if (months < 12) return ago.format(-months, "month");
  return ago.format(-Math.floor(days / 365), "year");
}

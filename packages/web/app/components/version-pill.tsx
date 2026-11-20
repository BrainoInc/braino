import { useT } from "@doco/shared/i18n/react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/cn";
import { TAGLINE } from "~/lib/tagline";
import { timeAgo } from "~/lib/time-ago";

const MINUTE = 60_000;

export function VersionPill({ className }: { className?: string }) {
  const t = useT();
  const releasedAt = new Date(__DOCO_RELEASE_AT__).getTime();
  const [now, setNow] = useState(releasedAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, MINUTE);
    return () => window.clearInterval(id);
  }, []);
  const ago = timeAgo(t, new Date(releasedAt).toISOString(), new Date(now));
  return (
    <span
      className={cn(
        "flex min-w-0 flex-col gap-0.5 font-normal text-xs leading-tight text-muted-foreground",
        className,
      )}
      suppressHydrationWarning
    >
      <span className="truncate opacity-50">
        {t("Private beta {version} · {ago}", { version: __DOCO_VERSION__, ago })}
      </span>
      <span className="hidden text-balance sm:line-clamp-2">{t(TAGLINE)}</span>
    </span>
  );
}

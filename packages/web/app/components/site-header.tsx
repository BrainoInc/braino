import { useT } from "@doco/shared/i18n/react";
import { Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, NavLink } from "react-router";
import { BrainoMark } from "~/components/braino-mark";
import { LanguageMenu } from "~/components/language-menu";
import { ThemeMenu } from "~/components/theme-menu";
import { VersionPill } from "~/components/version-pill";
import { cn } from "~/lib/cn";
import type { CurrentUser } from "~/lib/current-user.server";

interface SiteHeaderProps {
  user?: CurrentUser | null;
  isOwner?: boolean;
  initialized?: boolean;
}

const navButtonClass =
  "neu-button whitespace-nowrap rounded-md px-2.5 py-1.5 text-start font-semibold";
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(navButtonClass, isActive && "neu-pressed");

/** The one Hosted Braino-shaped app bar carried by every self-hosted page. */
export function SiteHeader({ user, isOwner = false, initialized = true }: SiteHeaderProps) {
  const t = useT();
  return (
    <header className="h-14 border-b border-border bg-card">
      <div className="flex h-full w-full items-center gap-6 px-6">
        <h1 className="m-0 flex min-w-0 items-center gap-3 leading-none">
          <NavLink
            to="/"
            className="inline-flex items-center hover:opacity-80"
            aria-label={t("Braino home")}
          >
            <BrainoMark height={28} />
          </NavLink>
          <VersionPill />
        </h1>
        <div className="ms-auto flex shrink-0 items-center gap-3 text-xs">
          {user ? (
            <>
              <nav className="hidden items-center gap-2 xl:flex">
                <NavButtons user={user} isOwner={isOwner} />
              </nav>
              <MobileNavMenu user={user} isOwner={isOwner} />
            </>
          ) : initialized ? (
            <NavLink
              to="/"
              className="neu-button whitespace-nowrap rounded-md px-3 py-1.5 font-semibold"
            >
              {t("Sign in")}
            </NavLink>
          ) : null}
          <ThemeMenu />
          <LanguageMenu />
        </div>
      </div>
    </header>
  );
}

function NavButtons({
  user,
  isOwner,
  onNavigate,
}: {
  user: CurrentUser;
  isOwner: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  return (
    <>
      <NavLink to="/" end className={navLinkClass} onClick={onNavigate}>
        {t("Workspace")}
      </NavLink>
      <NavLink to="/collaborators" className={navLinkClass} onClick={onNavigate}>
        {t("Collaborators")}
      </NavLink>
      <NavLink to="/mcp-tokens" className={navLinkClass} onClick={onNavigate}>
        {t("Tokens/MCP")}
      </NavLink>
      {isOwner ? (
        <NavLink to="/admin" className={navLinkClass} onClick={onNavigate}>
          {t("Admin")}
        </NavLink>
      ) : null}
      <NavLink
        to="/collaborators"
        className={cn(navButtonClass, "max-w-48 truncate")}
        onClick={onNavigate}
      >
        {user.name}
      </NavLink>
      <Form method="post" action="/" className="contents">
        <input type="hidden" name="intent" value="signout" />
        <button type="submit" className={navButtonClass}>
          {t("Sign out")}
        </button>
      </Form>
    </>
  );
}

function MobileNavMenu({ user, isOwner }: { user: CurrentUser; isOwner: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative xl:hidden">
      <button
        type="button"
        aria-label={t("Open navigation menu")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="neu-button inline-flex h-9 w-9 items-center justify-center rounded-md"
      >
        <Menu className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div
          aria-label={t("Navigation")}
          className="neu-floating absolute end-0 top-full z-[130] mt-2 flex w-48 flex-col gap-2 rounded-md bg-card p-2"
        >
          <NavButtons user={user} isOwner={isOwner} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

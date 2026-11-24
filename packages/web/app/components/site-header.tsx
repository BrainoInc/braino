import { useT } from "@doco/shared/i18n/react";
import { AppHeader, BrainoMark } from "@doco/ui";
import { Form, NavLink } from "react-router";
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
    <AppHeader
      home={
        <h1 className="m-0 leading-none">
          <NavLink
            to="/"
            className="inline-flex items-center hover:opacity-80"
            aria-label={t("Braino home")}
          >
            <BrainoMark height={28} />
          </NavLink>
        </h1>
      }
      badges={<VersionPill />}
      {...(user
        ? {
            navigation: ({ onNavigate }: { onNavigate?: () => void }) => (
              <NavButtons user={user} isOwner={isOwner} onNavigate={onNavigate} />
            ),
          }
        : {})}
      signedOutAction={
        !user && initialized ? (
          <NavLink
            to="/"
            className="neu-button whitespace-nowrap rounded-md px-3 py-1.5 font-semibold"
          >
            {t("Sign in")}
          </NavLink>
        ) : null
      }
      utilities={
        <>
          <ThemeMenu />
          <LanguageMenu />
        </>
      }
      menuLabel={t("Open navigation menu")}
      navigationLabel={t("Navigation")}
    />
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
        {t("Agent access")}
      </NavLink>
      {isOwner ? (
        <>
          <NavLink to="/plugins" className={navLinkClass} onClick={onNavigate}>
            {t("Plugins")}
          </NavLink>
          <NavLink to="/admin" className={navLinkClass} onClick={onNavigate}>
            {t("Admin")}
          </NavLink>
        </>
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

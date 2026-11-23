import { type ReactNode, useEffect, useRef, useState } from "react";

export interface AppHeaderProps {
  home: ReactNode;
  badges?: ReactNode;
  navigation?: (options: { onNavigate?: () => void }) => ReactNode;
  signedOutAction?: ReactNode;
  utilities?: ReactNode;
  menuLabel: string;
  navigationLabel: string;
}

export function AppHeaderMobilePanel({
  navigationLabel,
  children,
}: {
  navigationLabel: string;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={navigationLabel}
      className="neu-floating absolute end-0 top-full z-[130] mt-2 flex w-48 flex-col gap-2 rounded-md bg-card p-2"
    >
      {children}
    </nav>
  );
}

/** One responsive application bar for hosted and self-hosted Braino. */
export function AppHeader({
  home,
  badges,
  navigation,
  signedOutAction,
  utilities,
  menuLabel,
  navigationLabel,
}: AppHeaderProps) {
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
    <header className="h-14 border-b border-border bg-card">
      <div className="flex h-full w-full items-center gap-6 px-6">
        <div className="m-0 flex min-w-0 items-center gap-3 leading-none">
          {home}
          {badges}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-3 text-xs">
          {navigation ? (
            <>
              <nav className="hidden items-center gap-2 xl:flex">{navigation({})}</nav>
              <div ref={wrapperRef} className="relative xl:hidden">
                <button
                  type="button"
                  aria-label={menuLabel}
                  aria-expanded={open}
                  onClick={() => setOpen((value) => !value)}
                  className="neu-button inline-flex h-9 w-9 items-center justify-center rounded-md"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                    <path
                      d="M4 6h16M4 12h16M4 18h16"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                {open ? (
                  <AppHeaderMobilePanel navigationLabel={navigationLabel}>
                    {navigation({ onNavigate: () => setOpen(false) })}
                  </AppHeaderMobilePanel>
                ) : null}
              </div>
            </>
          ) : (
            signedOutAction
          )}
          {utilities}
        </div>
      </div>
    </header>
  );
}

import * as React from "react";
import { classes } from "./classes.js";

export const PageMain = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<"main">>(
  ({ className, ...props }, ref) => (
    <main ref={ref} className={classes("mx-auto w-full max-w-6xl px-6", className)} {...props} />
  ),
);
PageMain.displayName = "PageMain";

export const NarrowPageMain = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<"main">>(
  ({ className, ...props }, ref) => (
    <main ref={ref} className={classes("mx-auto w-full max-w-md px-6", className)} {...props} />
  ),
);
NarrowPageMain.displayName = "NarrowPageMain";

export function PageHeader({
  breadcrumb,
  title,
  actions,
  children,
  className,
}: {
  breadcrumb?: React.ReactNode;
  title: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={classes("space-y-1", className)}>
      {breadcrumb}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

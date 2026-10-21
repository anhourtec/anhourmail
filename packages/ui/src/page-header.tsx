// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * App page header (branding.md "Page header"): optional breadcrumb, title, one-line description, actions on the
 * right. No eyebrow label — the breadcrumb carries context, and only when the page is at least two levels deep.
 */
export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${String(i)}`} className="flex items-center gap-1">
              {last || !c.href ? (
                <span aria-current={last ? "page" : undefined} className={last ? "text-foreground" : undefined}>
                  {c.label}
                </span>
              ) : (
                <a href={c.href} className="rounded transition-colors hover:text-foreground">
                  {c.label}
                </a>
              )}
              {!last && <ChevronRight className="size-3.5 opacity-60" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  actions,
}: {
  title: string;
  description?: string;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      <Breadcrumbs items={breadcrumbs} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="am-h1">{title}</h1>
          {description && <p className="am-lead max-w-[68ch]">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

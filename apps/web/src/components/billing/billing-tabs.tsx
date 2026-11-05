// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

/**
 * The two Billing pages as tabs under the page header: "Plan and payments" (`/billing`) and "Usage"
 * (`/billing/usage`). Both pages sit behind the same `billing.read` guard (the billing layout), so every role that
 * sees one sees the other. A plain server component: the page says which tab is current.
 */
export function BillingTabs({ accountId, current }: { accountId: string; current: "plan" | "usage" }) {
  const tabs = [
    { id: "plan", label: "Plan and payments", href: `/accounts/${accountId}/billing` },
    { id: "usage", label: "Usage", href: `/accounts/${accountId}/billing/usage` },
  ] as const;
  return (
    <nav aria-label="Billing" className="-mt-2 border-b">
      <ul className="flex gap-6">
        {tabs.map((t) => {
          const active = t.id === current;
          return (
            <li key={t.id}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px inline-flex h-11 items-center border-b-2 text-[15px] transition-colors ${
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

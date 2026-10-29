// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { pendingDeletions } from "@anhourmail/core/data";
import { PageHeader } from "@anhourmail/ui/page-header";

import { StatusText } from "@/components/console/status-text";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Pending deletions" };

const dayFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/**
 * Staff (`platform.deletions.read`, Global Administrators): customer accounts an Owner asked to delete, soonest first.
 * Read-only: only the account's Owners can cancel; a staff suspension holds the removal until it is lifted (ADR-0025).
 */
export default async function PendingDeletionsPage() {
  const actor = await requireUser();
  const rows = await pendingDeletions(container().deps, actor);
  return (
    <>
      <PageHeader
        title="Pending deletions"
        description="Customer accounts waiting to be deleted. Their mailboxes are suspended; everything is removed after the grace period unless an Owner cancels."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Platform" }, { label: "Pending deletions" }]}
      />
      {rows.length === 0 ? (
        <p className="am-body rounded-lg border px-4 py-3">No account is waiting to be deleted.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[14px]">
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Account
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Requested
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Deleted on
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.accountId} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/platform/accounts/${r.accountId}`}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {r.accountName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono">{dayFmt.format(r.requestedAt)}</td>
                  <td className="px-3 py-2 font-mono">{dayFmt.format(r.deleteAfter)}</td>
                  <td className="px-3 py-2">
                    <StatusText tone={r.started ? "danger" : "warning"}>
                      {r.started ? "Being removed" : "In grace period"}
                    </StatusText>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

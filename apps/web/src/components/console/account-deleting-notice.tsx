// SPDX-License-Identifier: AGPL-3.0-only
import { TriangleAlert } from "lucide-react";
import Link from "next/link";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" });

/**
 * Shown above every page of an account that is waiting to be deleted (ADR-0025), to everyone in it: when it goes, that
 * its mailboxes are suspended, and that nothing can change until an Owner cancels (Owners get the link).
 */
export function AccountDeletingNotice({
  accountName,
  deleteAfter,
  started,
  settingsHref,
}: {
  accountName: string;
  deleteAfter: Date;
  started: boolean;
  /** Owners: their Account settings page (where they can cancel). */
  settingsHref: string | null;
}) {
  return (
    <section
      role="status"
      aria-labelledby="account-deleting-title"
      className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="account-deleting-title" className="am-h4 break-words">
            {started ? "This account is being deleted" : "This account is scheduled for deletion"}
          </h2>
          <p className="am-small text-foreground">
            <span className="font-medium">{accountName}</span> will be deleted on{" "}
            <span className="am-num">{dateFmt.format(deleteAfter)}</span> (UTC). Its mailboxes are suspended and nothing
            in it can be changed until an Owner cancels the deletion.
          </p>
          {settingsHref && !started && (
            <Link href={settingsHref} className="am-small text-primary underline-offset-2 hover:underline">
              Cancel the deletion in Account settings
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

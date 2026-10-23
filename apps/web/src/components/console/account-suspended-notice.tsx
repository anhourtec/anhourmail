// SPDX-License-Identifier: AGPL-3.0-only
import { Ban } from "lucide-react";

import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });

/**
 * What the people of a suspended account see instead of the console (`platform.account.suspend`): the reason category
 * in plain words, what still holds (mail is kept) and how to appeal. Never staff's internal note.
 */
export function AccountSuspendedNotice({
  accountName,
  reasonLabel,
  since,
}: {
  accountName: string;
  reasonLabel: string | null;
  since: Date | null;
}) {
  return (
    <section
      role="alert"
      aria-labelledby="account-suspended-title"
      className="flex max-w-2xl flex-col gap-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5"
    >
      <div className="flex items-start gap-3">
        <Ban className="mt-1 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="account-suspended-title" className="am-h3">
            This account is suspended
          </h2>
          <p className="am-small break-words">
            Anhourtec suspended <span className="font-medium">{accountName}</span>
            {since ? (
              <>
                {" "}
                on <span className="am-num">{dateFmt.format(since)}</span>
              </>
            ) : null}
            .
          </p>
        </div>
      </div>
      {reasonLabel && (
        <p className="am-body">
          <span className="font-medium">Reason:</span> {reasonLabel}
        </p>
      )}
      <ul className="am-body flex list-disc flex-col gap-1 pl-5">
        <li>Your stored mail is kept. Mail sent to the account&apos;s mailboxes is returned to its senders.</li>
        <li>Its mailboxes can&apos;t sign in, send or receive mail, and the console&apos;s other pages are closed.</li>
        <li>Your own Security page still works.</li>
      </ul>
      <p className="am-body">
        If you think this is a mistake, email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="font-mono text-primary underline underline-offset-2">
          {SUPPORT_EMAIL}
        </a>{" "}
        from your sign-in address and tell us why. A person reads every appeal.
      </p>
    </section>
  );
}

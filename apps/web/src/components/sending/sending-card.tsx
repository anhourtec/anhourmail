// SPDX-License-Identifier: AGPL-3.0-only
import { Send } from "lucide-react";

import type { AccountSending } from "@anhourmail/core/trust";

import { StatusText } from "../console/status-text";

import { limitRows, sendingCopy } from "./sending-copy";

/**
 * The console's Sending card on the Account overview (`account.read`, ADR-0034 §5): the account's tier, its published
 * limits and, while new or restricted, what that means. Nothing else about the tier (no dates, thresholds or notes).
 */
export function SendingCard({
  accountId,
  sending,
  docsHref,
}: {
  accountId: string;
  sending: AccountSending;
  /** The public docs' "New accounts" section. */
  docsHref: string;
}) {
  const copy = sendingCopy(sending.tier, { subject: "account", reason: sending.reason?.label ?? null });
  const heading = `sending-${accountId}`;
  return (
    <section
      aria-labelledby={heading}
      data-testid="sending-card"
      className="flex max-w-2xl flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h4 id={heading} className="am-h4 flex items-center gap-2">
          <Send className="size-4 text-primary" aria-hidden />
          Sending
        </h4>
        <StatusText tone={copy.tone}>{copy.label}</StatusText>
      </div>
      <p className="am-small max-w-prose">{copy.summary}</p>
      {copy.showLimits && (
        <dl className="grid grid-cols-3 gap-3 border-t pt-3">
          {limitRows(sending.limits).map((r) => (
            <div key={r.label} className="flex flex-col gap-0.5">
              <dt className="am-micro">{r.label}</dt>
              <dd className="am-num text-[15px]">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {copy.notes.map((n) => (
        <p key={n} className="am-small max-w-prose">
          {n}
        </p>
      ))}
      {copy.appeal && (
        <p className="am-small max-w-prose">
          To ask us to look again, write to{" "}
          <a href={`mailto:${copy.appeal}`} className="am-code text-primary underline-offset-2 hover:underline">
            {copy.appeal}
          </a>
          .
        </p>
      )}
      {copy.linkNewAccounts && (
        <a href={docsHref} className="w-fit text-[14px] text-primary underline-offset-2 hover:underline">
          What new accounts can send
        </a>
      )}
    </section>
  );
}

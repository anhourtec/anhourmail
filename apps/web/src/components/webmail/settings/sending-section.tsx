// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { CircleCheck, CircleX, ExternalLink, Info, type LucideIcon, Send } from "lucide-react";

import { TRUST_TIERS, type TrustTier } from "@anhourmail/shared/sending";

import { limitRows, sendingCopy, type SendingTone } from "../../sending/sending-copy";

import { Group } from "./controls";

const TONES: Record<SendingTone, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheck, className: "text-[rgb(var(--am-status-success))]" },
  info: { icon: Info, className: "text-primary" },
  warning: { icon: Info, className: "text-[rgb(var(--am-status-warning))]" },
  danger: { icon: CircleX, className: "text-[rgb(var(--am-status-danger))]" },
};

/**
 * Settings → Account → Sending (ADR-0034 §5): the open mailbox's sending tier (its account's, or restricted while this
 * mailbox alone is), the published limits, and while new or restricted what that means here, including what it pauses
 * in Forwarding and Automatic replies. `tier` null: it couldn't be read just now.
 */
export function SendingSection({ tier, docsHref }: { tier: TrustTier | null; docsHref: string | undefined }) {
  if (tier === null) {
    return (
      <Group title="Sending">
        <p className="am-small px-4 py-3">Your sending limits couldn&apos;t be loaded. Close Settings and try again.</p>
      </Group>
    );
  }
  const copy = sendingCopy(tier, { subject: "mailbox", settings: true });
  const tone = TONES[copy.tone];
  const Icon = tone.icon;
  return (
    <Group title="Sending">
      <div className="flex flex-col gap-2 px-4 py-3" data-testid="webmail-sending">
        <div className="flex items-center gap-2 text-[14px]">
          <Send className="size-4 text-muted-foreground" aria-hidden />
          <span>Level</span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Icon className={`size-4 shrink-0 ${tone.className}`} aria-hidden />
            {copy.label}
          </span>
        </div>
        <p className="am-small max-w-prose">{copy.summary}</p>
      </div>
      {copy.showLimits && (
        <dl className="grid grid-cols-3 gap-3 px-4 py-3">
          {limitRows(TRUST_TIERS[tier].limits).map((r) => (
            <div key={r.label} className="flex flex-col gap-0.5">
              <dt className="am-micro">{r.label}</dt>
              <dd className="font-mono text-[14px]">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(copy.notes.length > 0 || copy.appeal !== null || (copy.linkNewAccounts && docsHref !== undefined)) && (
        <div className="flex flex-col gap-2 px-4 py-3">
          {copy.notes.map((n) => (
            <p key={n} className="am-small max-w-prose">
              {n}
            </p>
          ))}
          {copy.appeal && (
            <p className="am-small max-w-prose">
              To ask us to look again, write to{" "}
              <a href={`mailto:${copy.appeal}`} className="font-mono text-primary hover:underline">
                {copy.appeal}
              </a>
              .
            </p>
          )}
          {copy.linkNewAccounts && docsHref && (
            <a
              href={docsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-[13.5px] text-primary hover:underline"
            >
              What new accounts can send <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </div>
      )}
    </Group>
  );
}

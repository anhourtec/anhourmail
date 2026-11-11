// SPDX-License-Identifier: AGPL-3.0-only
import type { StaffTrustView } from "@anhourmail/core/trust";
import { SUSPENSION_REASONS } from "@anhourmail/shared/platform";
import { TRUST_TIERS, type TrustTierSource } from "@anhourmail/shared/sending";

import { Field, FieldGrid } from "../console/flyout";
import { StatusText } from "../console/status-text";
import { TIER_TONE } from "../sending/sending-copy";

import { ChangeTierControl } from "./trust-controls";

/** How the account got its tier, in staff words (ADR-0034 §1–2). */
export const TRUST_SOURCE_LABELS: Readonly<Record<TrustTierSource, string>> = {
  default: "Default for a new account",
  automatic: "Automatic (promotion job)",
  billing: "A paid plan",
  staff: "Set by staff (stays until staff change it)",
};

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const when = (d: Date) => <span className="am-num">{dateFmt.format(d)} UTC</span>;

/**
 * Platform → customer account → Trust (ADR-0034 §5): the account's sending tier, how it got it, since when and why, and
 * when it was last restricted; the internal note only for readers with `platform.suspensionNotes.read` (the server
 * leaves it out otherwise). `canChange` (`platform.trust.manage`, not while acting as someone) adds Change tier.
 */
export function TrustCard({
  accountId,
  accountName,
  view,
  canChange,
}: {
  accountId: string;
  accountName: string;
  view: StaffTrustView;
  canChange: boolean;
}) {
  const restricted = view.mailboxes.filter((m) => m.restriction !== null).length;
  return (
    <section
      aria-labelledby="trust-title"
      data-testid="staff-trust"
      className="flex flex-col gap-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="trust-title" className="am-h3">
            Trust
          </h2>
          <p className="am-small">What this account may send, and how it got there.</p>
        </div>
        {canChange && <ChangeTierControl accountId={accountId} current={view.tier} subject={accountName} />}
      </div>
      <FieldGrid>
        <Field label="Tier">
          <StatusText tone={TIER_TONE[view.tier]}>{TRUST_TIERS[view.tier].label}</StatusText>
        </Field>
        <Field label="Source">{TRUST_SOURCE_LABELS[view.source]}</Field>
        <Field label="Since">{when(view.since)}</Field>
        <Field label="Reason">{view.reason ? SUSPENSION_REASONS[view.reason] : "None given"}</Field>
        {view.lastRestrictedAt && <Field label="Last restricted">{when(view.lastRestrictedAt)}</Field>}
        <Field label="Mailboxes restricted">
          <span className="am-num">{restricted}</span> of <span className="am-num">{view.mailboxes.length}</span>{" "}
          <span className="am-small">(see Mailboxes)</span>
        </Field>
        {view.note !== undefined && (
          <Field label="Internal note">
            {view.note ? <span className="break-words whitespace-pre-line">{view.note}</span> : "None"}
          </Field>
        )}
      </FieldGrid>
    </section>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import type { PlatformBillingView } from "@anhourmail/core/billing";
import { formatPrice, PLANS } from "@anhourmail/shared/plans";

import { BILLING_STATE_LABELS, billingDate, PLAN_SOURCE_LABELS } from "../billing/labels";
import { ListEmpty } from "../console/data-list";
import { Field, FieldGrid } from "../console/flyout";
import { listClass } from "../console/list-classes";
import { StatusText } from "../console/status-text";
import { CopyValue } from "../copy-value";

import { CeilingOverrideControl, EndGrantControl, GrantPlanControl, StaffRefundControl } from "./billing-controls";

const at = (d: Date | null) => (d ? <span className="am-num">{billingDate.format(d)}</span> : "—");

/**
 * Platform → account → Billing (staff with `platform.billing.manage`; ADR-0029 §9): the account's billing state, the
 * provider's customer and subscription ids (for looking them up at the processor), the last sync, disputes, events
 * waiting, holds and the address ceiling; then grants, the staff refund and the ceiling override. Every action asks for
 * the password step-up and shows in the account's own audit log as Anhourtec staff.
 */
export function AccountBillingPanel({
  accountId,
  view,
  canAct,
}: {
  accountId: string;
  view: PlatformBillingView;
  /** Not while acting as someone (the server refuses too). */
  canAct: boolean;
}) {
  const b = view.row;
  const label = BILLING_STATE_LABELS[b.state];
  return (
    <div className="flex flex-col gap-6" data-testid="staff-billing">
      {!view.available && (
        <p className="am-small rounded-lg border px-4 py-3">
          Billing is off on this deployment: grants still work; refunds need the payment provider.
        </p>
      )}
      <FieldGrid>
        <Field label="State">
          <span className="flex flex-wrap items-center gap-x-3">
            <StatusText tone={label.tone}>{label.text}</StatusText>
            <span className="am-small">since {at(b.stateSince)}</span>
          </span>
        </Field>
        <Field label="Plan">
          {PLANS[view.plan].name} · {PLAN_SOURCE_LABELS[b.planSource]}
        </Field>
        {b.planAmountMinor !== null && b.currency !== null && (
          <Field label="Plan amount">
            <span className="am-num">{formatPrice(b.planAmountMinor, b.currency)}</span> a year
          </Field>
        )}
        <Field label="Add-ons (renewal / in force)">
          <span className="am-num">
            {b.storageBlocks}/{view.entitled.storageBlocks} storage · {b.extraMailboxes}/{view.entitled.extraMailboxes}{" "}
            mailboxes
          </span>
        </Field>
        <Field label="Period ends">{at(b.currentPeriodEnd)}</Field>
        {b.cancelAt && <Field label="Cancels on">{at(b.cancelAt)}</Field>}
        {b.compUntil && <Field label="Complimentary until">{at(b.compUntil)}</Field>}
        {b.restrictedAt && <Field label="Sending paused since">{at(b.restrictedAt)}</Field>}
        {b.disputedAt && <Field label="Disputed since">{at(b.disputedAt)}</Field>}
        {b.lapsedAt && <Field label="Lapsed on">{at(b.lapsedAt)}</Field>}
        <Field label="Self-service refund">
          {b.selfServiceRefundAt ? <>Used {at(b.selfServiceRefundAt)}</> : "Not used"}
        </Field>
        <Field label="Provider customer">
          {b.providerCustomerId ? <CopyValue value={b.providerCustomerId} label="provider customer id" /> : "—"}
        </Field>
        <Field label="Provider subscription">
          {b.providerSubscriptionId ? (
            <CopyValue value={b.providerSubscriptionId} label="provider subscription id" />
          ) : (
            "—"
          )}
        </Field>
        <Field label="Last invoice">
          {b.lastInvoiceId ? (
            <span className="font-mono text-[13px] break-all">
              {b.lastInvoiceId} ({b.lastInvoiceStatus ?? "unknown"})
            </span>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Last sync">
          {b.lastSyncedAt ? at(b.lastSyncedAt) : "Never"}
          {view.queuedEvents > 0 && <span className="am-small block">{view.queuedEvents} events waiting</span>}
        </Field>
        <Field label="Held items">
          <span className="am-num">{view.holds}</span>
        </Field>
        <Field label="Addresses">
          <span className="am-num">
            {view.addresses} of {view.ceiling.effective}
          </span>
          {b.addressCeilingOverride !== null && <span className="am-small block">Raised by staff</span>}
        </Field>
      </FieldGrid>

      <section aria-labelledby={`disputes-${accountId}`} className="flex flex-col gap-2">
        <h3 id={`disputes-${accountId}`} className="am-h4">
          Disputes
        </h3>
        {view.disputes.length === 0 ? (
          <ListEmpty>No disputes.</ListEmpty>
        ) : (
          <div className={listClass.wrap}>
            <table className={listClass.table}>
              <thead>
                <tr>
                  <th scope="col" className={listClass.th}>
                    Dispute
                  </th>
                  <th scope="col" className={listClass.th}>
                    Status
                  </th>
                  <th scope="col" className={`${listClass.th} hidden sm:table-cell`}>
                    Opened
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.disputes.map((d) => (
                  <tr key={d.disputeId} className={listClass.row}>
                    <td className={`${listClass.td} font-mono text-[13px] break-all`}>{d.disputeId}</td>
                    <td className={listClass.td}>{d.status.replace("_", " ")}</td>
                    <td className={`${listClass.td} am-num hidden sm:table-cell`}>{billingDate.format(d.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canAct && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-3">
            {view.can.endGrant && <EndGrantControl accountId={accountId} />}
            {view.can.refund && <StaffRefundControl accountId={accountId} />}
          </div>
          {view.can.grant && <GrantPlanControl accountId={accountId} />}
          <CeilingOverrideControl
            accountId={accountId}
            override={b.addressCeilingOverride}
            configured={view.ceiling.configured}
          />
        </div>
      )}
    </div>
  );
}

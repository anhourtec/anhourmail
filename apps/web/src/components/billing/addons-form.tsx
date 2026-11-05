// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

import {
  BILLING,
  type Currency,
  formatPrice,
  MAX_EXTRA_MAILBOXES,
  MAX_STORAGE_BLOCKS,
  PLANS,
} from "@anhourmail/shared/plans";

import { ChangeForm } from "./change-form";
import { Stepper } from "./stepper";

/**
 * Storage blocks and extra mailboxes on a paid subscription (ADR-0029 §7): start from what the subscription renews
 * with, preview, confirm. One direction per change: add, or lower (the server refuses a mix, and a lower figure the
 * account doesn't fit: delete a mailbox or lower mailbox storage first).
 */
export function AddonsForm({
  accountId,
  currency,
  renewal,
  restricted,
}: {
  accountId: string;
  currency: Currency;
  renewal: { storageBlocks: number; extraMailboxes: number };
  /** Sending is paused for a payment: adding is refused until it's paid (lowering still works). */
  restricted: boolean;
}) {
  const [blocks, setBlocks] = useState(renewal.storageBlocks);
  const [extras, setExtras] = useState(renewal.extraMailboxes);
  const plus = PLANS.plus;
  const changed = blocks !== renewal.storageBlocks || extras !== renewal.extraMailboxes;
  const per = (minor: number | undefined) => `${formatPrice(minor ?? 0, currency)}/${BILLING.interval}`;
  return (
    <ChangeForm
      accountId={accountId}
      body={{ storageBlocks: blocks, extraMailboxes: extras }}
      changed={changed}
      renewalText={`It renews with ${String(blocks)} storage ${blocks === 1 ? "block" : "blocks"} and ${String(extras)} extra ${extras === 1 ? "mailbox" : "mailboxes"}.`}
      fields={(edited) => (
        <div className="flex flex-col gap-3">
          <Stepper
            label={`Storage blocks (+${String(plus.storageBlockGb ?? 0)} GB each, ${per(plus.storageBlockPrice?.[currency])})`}
            value={blocks}
            max={MAX_STORAGE_BLOCKS}
            onChange={(n) => {
              setBlocks(n);
              edited();
            }}
          />
          <Stepper
            label={`Extra mailboxes (${per(plus.extraMailboxPrice?.[currency])} each)`}
            value={extras}
            max={MAX_EXTRA_MAILBOXES}
            onChange={(n) => {
              setExtras(n);
              edited();
            }}
          />
          <p className="am-micro max-w-prose">
            Adding is charged now for the rest of this period. Lowering costs nothing now and renews lower; what
            you&apos;ve paid for stays until the period ends. Add and lower in separate changes.
            {restricted ? " While a payment is outstanding you can lower, but not add." : ""}
          </p>
        </div>
      )}
    />
  );
}

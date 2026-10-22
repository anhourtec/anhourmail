// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxStatus as Status } from "@anhourmail/core/mailboxes";

import { StatusText, type Tone } from "../console/status-text";

export const MAILBOX_STATUS: Record<Status, { text: string; tone: Tone }> = {
  provisioning: { text: "Setting up", tone: "info" },
  active: { text: "Active", tone: "success" },
  failed: { text: "Couldn't set up", tone: "danger" },
  suspended: { text: "Suspended", tone: "neutral" },
  deleting: { text: "Deleting", tone: "warning" },
};

/**
 * A mailbox's status: small coloured icon and text. `applyFailed` on a suspended or deleting mailbox adds "Not
 * applied": the worker gave up, so the mail server may still allow access (retry from the mailbox's panel).
 */
export function MailboxStatus({ status, applyFailed = false }: { status: Status; applyFailed?: boolean }) {
  const l = MAILBOX_STATUS[status];
  const notApplied = applyFailed && (status === "suspended" || status === "deleting");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusText tone={l.tone}>{l.text}</StatusText>
      {notApplied && <StatusText tone="danger">Not applied</StatusText>}
    </span>
  );
}

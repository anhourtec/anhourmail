// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxStatus as Status } from "@anhourmail/core/mailboxes";

const LABEL: Record<Status, { text: string; tone: string }> = {
  provisioning: { text: "Setting up", tone: "info" },
  active: { text: "Active", tone: "success" },
  failed: { text: "Couldn't set up", tone: "danger" },
  suspended: { text: "Suspended", tone: "neutral" },
};

/** Status badge for a mailbox. */
export function MailboxStatus({ status }: { status: Status }) {
  const l = LABEL[status];
  return <span className={`am-status am-status--${l.tone}`}>{l.text}</span>;
}

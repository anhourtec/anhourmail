// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxStatus as Status } from "@anhourmail/core/mailboxes";

const LABEL: Record<Status, { text: string; tone: string }> = {
  provisioning: { text: "Setting up", tone: "info" },
  active: { text: "Active", tone: "success" },
  failed: { text: "Couldn't set up", tone: "danger" },
  suspended: { text: "Suspended", tone: "neutral" },
  deleting: { text: "Deleting", tone: "warning" },
};

/**
 * Status badge for a mailbox. `applyFailed` on a suspended or deleting mailbox adds "Not applied": the worker gave up,
 * so the mail server may still allow access (retry from the mailbox page).
 */
export function MailboxStatus({ status, applyFailed = false }: { status: Status; applyFailed?: boolean }) {
  const l = LABEL[status];
  const notApplied = applyFailed && (status === "suspended" || status === "deleting");
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <span className={`am-status am-status--${l.tone}`}>{l.text}</span>
      {notApplied && <span className="am-status am-status--danger">Not applied</span>}
    </span>
  );
}

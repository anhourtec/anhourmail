// SPDX-License-Identifier: AGPL-3.0-only
import { importEndText, IMPORT_ROLE_LABELS } from "@anhourmail/shared/import";

import type { MailMessage } from "./index";
import { systemEmail } from "./layout";

/*
 * Mail import emails (ADR-0030 §16): the summary when an import ends, sent by the worker's `job:import-notify`.
 * Transactional mail from our own domain (rule 62 allows it). Counts per folder role only — never folder names,
 * subjects or addresses from the mail (rule 24). The link goes to the console's import page.
 */

const n = (v: number) => new Intl.NumberFormat("en-CA").format(v);
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/** "about 2 hours", "12 minutes", "less than a minute". */
export function importDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute";
  if (min < 90) return plural(min, "minute", "minutes");
  const h = Math.round(min / 60);
  if (h < 48) return `about ${plural(h, "hour", "hours")}`;
  return `about ${plural(Math.round(h / 24), "day", "days")}`;
}

type RoleCounts = {
  role: keyof typeof IMPORT_ROLE_LABELS;
  copied: number;
  duplicates: number;
  tooLarge: number;
  failed: number;
};

/** One line per role: "Inbox: 1,204 copied, 3 duplicates skipped". */
export function importRoleLine(c: RoleCounts): string {
  const parts = [`${n(c.copied)} copied`];
  if (c.duplicates > 0) parts.push(`${plural(c.duplicates, "duplicate", "duplicates")} skipped`);
  if (c.tooLarge > 0) parts.push(`${n(c.tooLarge)} too large`);
  if (c.failed > 0) parts.push(`${n(c.failed)} not accepted`);
  return `${IMPORT_ROLE_LABELS[c.role]}: ${parts.join(", ")}`;
}

/** An import ended: what was copied, per folder role, and how long it took. */
export function importSummaryEmail(input: {
  to: string;
  address: string;
  startedByRecipient: boolean;
  startedBy: string | null;
  status: "completed" | "failed";
  errorCode: string | null;
  roles: RoleCounts[];
  totals: { copied: number; duplicates: number; tooLarge: number; failed: number };
  startedAt: Date | null;
  finishedAt: Date | null;
  url: string;
  site: string;
}): MailMessage {
  const done = input.status === "completed" && input.errorCode === null;
  const subject = done ? "Your mail import is finished" : "Your mail import has ended";
  const who = input.startedByRecipient
    ? "The import you started"
    : input.startedBy
      ? `The import ${input.startedBy} started`
      : "The import an admin started";
  const took =
    input.startedAt && input.finishedAt
      ? ` It took ${importDuration(input.finishedAt.getTime() - input.startedAt.getTime())}.`
      : "";
  const lines = [
    `${who} into ${input.address} has ${done ? "finished" : "ended"}: ${plural(input.totals.copied, "message", "messages")} copied.${took}`,
    ...(input.roles.length > 0 ? input.roles.map(importRoleLine) : []),
  ];
  const end = importEndText(input.errorCode);
  if (end) lines.push(end);
  if (input.totals.tooLarge > 0) {
    lines.push(
      `${plural(input.totals.tooLarge, "message was", "messages were")} larger than the per-message limit and stayed at the old provider.`,
    );
  }
  if (input.totals.failed > 0) {
    lines.push(
      `${plural(input.totals.failed, "message wasn't", "messages weren't")} accepted by your mailbox and stayed at the old provider.`,
    );
  }
  return systemEmail({
    to: input.to,
    subject,
    preheader: `${plural(input.totals.copied, "message", "messages")} copied into ${input.address}.`,
    greeting: "Hi,",
    lines,
    action: { label: "See the import", url: input.url },
    note: "The old mailbox was only read: nothing there was changed or deleted. The import's sign-in details are deleted now.",
    reason: "We send this when a mail import into your mailbox ends.",
    site: input.site,
  });
}

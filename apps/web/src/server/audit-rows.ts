// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { type ActorDescription, actionLabel, areaLabel, type AuditEntry, describeActor } from "@anhourmail/core/audit";

/**
 * What the audit table and its detail drawer show for one entry. Built on the server: labels, the actor as people
 * should read it (staff always named as staff, rule 49), UTC times, and the already-redacted meta as JSON.
 */
export type AuditRow = {
  id: string;
  seq: number;
  at: string;
  atFull: string;
  action: string;
  actionLabel: string;
  areaLabel: string;
  actor: ActorDescription;
  /** Act-as reason or a staff note, when the entry has one. */
  reason: string | null;
  target: { type: string; id: string | null; label: string | null };
  result: AuditEntry["result"];
  errorCode: string | null;
  ip: string | null;
  requestId: string | null;
  meta: string | null;
  hash: string;
};

const short = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});
const full = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "full",
  timeStyle: "long",
  timeZone: "UTC",
  hourCycle: "h23",
});

export function auditRows(entries: readonly AuditEntry[]): AuditRow[] {
  return entries.map((e) => {
    const at = new Date(e.at);
    return {
      id: e.id,
      seq: e.seq,
      at: `${short.format(at)} UTC`,
      atFull: full.format(at),
      action: e.action,
      actionLabel: actionLabel(e.action),
      areaLabel: areaLabel(e.action),
      actor: describeActor(e),
      reason: typeof e.meta.reason === "string" ? e.meta.reason : null,
      target: e.target,
      result: e.result,
      errorCode: e.errorCode,
      ip: e.ip,
      requestId: e.requestId,
      meta: Object.keys(e.meta).length > 0 ? JSON.stringify(e.meta, null, 2) : null,
      hash: e.hash,
    };
  });
}

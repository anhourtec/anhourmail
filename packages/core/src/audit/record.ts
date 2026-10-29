// SPDX-License-Identifier: AGPL-3.0-only
import { redact } from "@anhourmail/server/log";

import type { Actor } from "../actor";
import type { RequestMeta } from "../ports";
import type { AuditEntryInput } from "./types";

/** Actor fields for an audit entry, including act-as attribution. */
/**
 * `staffPath`: the action was taken through a staff (platform) path, e.g. opening an account from the staff console.
 * Staff are then recorded as staff even when they also belong to the account (rule 49).
 */
export function auditActor(
  actor: Actor,
  accountId: string | null,
  staffPath = false,
): Pick<AuditEntryInput, "actor" | "onBehalfOf"> {
  switch (actor.kind) {
    case "anonymous":
      return { actor: { type: "anonymous", userId: null, email: null, role: null, accountId: null }, onBehalfOf: null };
    case "system":
      return {
        actor: { type: "system", userId: null, email: actor.name, role: null, accountId: null },
        onBehalfOf: null,
      };
    case "user": {
      // Staff acting in a customer account (ADR-0023): always recorded as staff, with their platform role and the
      // act-as session, whichever scope the entry lands in (rule 49).
      if (actor.actingAs) {
        const a = actor.actingAs;
        return {
          actor: { type: "staff", userId: actor.userId, email: actor.email, role: a.staffRole, accountId: a.accountId },
          onBehalfOf: { userId: a.staffUserId, email: a.staffEmail, accountId: a.accountId, sessionId: a.sessionId },
        };
      }
      const asStaff = staffPath && actor.platformRoles.length > 0;
      const membership =
        accountId === null || asStaff ? undefined : actor.memberships.find((m) => m.accountId === accountId);
      const isStaffAction = membership === undefined && actor.platformRoles.length > 0;
      return {
        actor: {
          type: isStaffAction ? "staff" : "user",
          userId: actor.userId,
          email: actor.email,
          role: membership?.role ?? actor.platformRoles[0] ?? null,
          accountId: membership?.accountId ?? null,
        },
        onBehalfOf: null,
      };
    }
  }
}

/** Never mail content, secrets, tokens or passwords (rule 48): meta goes through the logging redaction list. */
export function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return redact(meta) as Record<string, unknown>;
}

export const requestFields = (req: RequestMeta) => ({
  requestId: req.requestId,
  ip: req.ip,
  userAgent: req.userAgent?.slice(0, 200) ?? null,
});

/** `w***@example.com` — enough to recognise an address in an audit view without storing it in full. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

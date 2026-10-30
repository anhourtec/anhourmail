// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox delegation (ADR-0026): the three rights an administrator gives a person in the account on a mailbox, and the
 * request shapes the console sends. One source for the services, the routes and the UI. Limits are in `plans.ts`
 * (`DELEGATES_PER_MAILBOX`, `DELEGATED_MAILBOXES_PER_PERSON`); the plan flag is `Plan.delegation`.
 */
import { z } from "zod";

import { DELEGATES_PER_MAILBOX } from "./plans";

/**
 * - `full_access` ("Read and manage"): open the mailbox in the webmail, read, move and delete in every folder; no sending.
 * - `send_as`: mail comes from the mailbox, with no sign of the delegate.
 * - `send_on_behalf`: `From:` is the mailbox and `Sender:` is the delegate. When someone holds both send rights, send
 *   as is used.
 */
export const DELEGATION_RIGHTS = ["full_access", "send_as", "send_on_behalf"] as const;
export type DelegationRight = (typeof DELEGATION_RIGHTS)[number];

export const isDelegationRight = (v: unknown): v is DelegationRight =>
  typeof v === "string" && (DELEGATION_RIGHTS as readonly string[]).includes(v);

/** Section headings in the console's Delegation tab and the people panel. */
export const DELEGATION_RIGHT_LABELS: Readonly<Record<DelegationRight, string>> = {
  full_access: "Read and manage",
  send_as: "Send as",
  send_on_behalf: "Send on behalf",
};

/** Changes one request may make (adds and removes together). */
export const DELEGATION_BATCH_MAX = 50;

/** A console person id (the identity layer's user id: opaque text, never trusted to be a uuid). */
const personId = z.string().trim().min(1).max(200);

export const delegationChangeSchema = z.strictObject({ userId: personId, right: z.enum(DELEGATION_RIGHTS) });
export type DelegationChange = z.infer<typeof delegationChangeSchema>;

/** `PUT /api/accounts/:accountId/mailboxes/:mailboxId/delegation`: people added to and removed from the three lists. */
export const delegationUpdateSchema = z
  .strictObject({
    add: z.array(delegationChangeSchema).max(DELEGATION_BATCH_MAX).default([]),
    remove: z.array(delegationChangeSchema).max(DELEGATION_BATCH_MAX).default([]),
  })
  .refine((v) => v.add.length + v.remove.length > 0, { message: "Choose at least one change." })
  .refine((v) => v.add.length + v.remove.length <= DELEGATION_BATCH_MAX, {
    message: `Make up to ${String(DELEGATION_BATCH_MAX)} changes at a time.`,
  })
  .refine((v) => !v.add.some((a) => v.remove.some((r) => r.userId === a.userId && r.right === a.right)), {
    message: "A change can't add and remove the same person's access at once.",
  });
export type DelegationUpdate = z.infer<typeof delegationUpdateSchema>;

/**
 * `POST …/mailboxes/:mailboxId/convert-to-shared`: optionally give people read and manage (and send as) on the mailbox
 * in the same change.
 */
export const convertToSharedSchema = z.strictObject({
  fullAccessTo: z.array(personId).max(DELEGATES_PER_MAILBOX).default([]),
  sendAs: z.boolean().default(false),
});
export type ConvertToSharedInput = z.infer<typeof convertToSharedSchema>;

/**
 * `DELETE /api/accounts/:accountId/members/:userId` (optional body): give one person read and manage (and send as) on
 * every mailbox the leaver owns, in the removal's own transaction.
 */
export const memberRemovalSchema = z.strictObject({
  delegateTo: z.strictObject({ userId: personId, sendAs: z.boolean().default(false) }).optional(),
});
export type MemberRemovalInput = z.infer<typeof memberRemovalSchema>;

/** The first problem in a failed parse, as one sentence for a 400 answer. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Check the request and try again.";
  return issue.code === "custom" ? issue.message : "Check the request and try again.";
}

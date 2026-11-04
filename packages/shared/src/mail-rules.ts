// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { SENDER_ADDRESS } from "./senders";

/**
 * Mail rules (filters) a person sets in webmail Settings (ADR-0032 §2): ordered rules of conditions and actions that
 * the server compiles into the mailbox's managed Sieve script. People never write Sieve: every value here is data,
 * validated by this schema (shared with the browser) and escaped by the compiler.
 */

export const MAIL_RULES = {
  maxRules: 50,
  maxConditions: 5,
  nameChars: 64,
  valueChars: 200,
  /** Size conditions, in KB (50 MB). */
  maxSizeKb: 50 * 1024,
} as const;

/** Control characters and line breaks become spaces; trimmed. */
const oneLine = (s: string) => s.replace(/\p{Cc}/gu, " ").trim();

const text = z
  .string()
  .max(MAIL_RULES.valueChars * 2)
  .transform(oneLine)
  .pipe(z.string().min(1, "Type what to look for.").max(MAIL_RULES.valueChars));

export const RuleCondition = z.discriminatedUnion("field", [
  z.object({ field: z.literal("from"), op: z.enum(["contains", "is"]), value: text }).strict(),
  z.object({ field: z.literal("toCc"), op: z.enum(["contains", "is"]), value: text }).strict(),
  z.object({ field: z.literal("subject"), op: z.literal("contains"), value: text }).strict(),
  z.object({ field: z.literal("listId"), op: z.literal("contains"), value: text }).strict(),
  z.object({ field: z.literal("attachment") }).strict(),
  z
    .object({ field: z.literal("size"), op: z.enum(["over", "under"]), kb: z.int().min(1).max(MAIL_RULES.maxSizeKb) })
    .strict(),
]);
export type RuleCondition = z.infer<typeof RuleCondition>;

/** Where a matching message goes: a folder (its JMAP id, and its path as compiled at save time) or Trash. */
export const RuleMove = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("folder"),
      folderId: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[A-Za-z0-9_-]+$/),
      path: z.string().max(1024),
    })
    .strict(),
  z.object({ kind: z.literal("trash") }).strict(),
]);
export type RuleMove = z.infer<typeof RuleMove>;

export const RuleActions = z
  .object({
    move: RuleMove.nullable(),
    markRead: z.boolean(),
    flag: z.boolean(),
    /** Forward a copy to the mailbox's confirmed forwarding address (the rule holds no address). */
    forward: z.boolean(),
    /** Don't run the rules after this one. Moving or deleting always stops. */
    stop: z.boolean(),
  })
  .strict()
  .refine((a) => a.move !== null || a.markRead || a.flag || a.forward || a.stop, {
    message: "Choose what the rule does.",
  });
export type RuleActions = z.infer<typeof RuleActions>;

export const MailRule = z
  .object({
    id: z.uuid(),
    name: z
      .string()
      .max(MAIL_RULES.nameChars * 2)
      .transform(oneLine)
      .pipe(z.string().min(1, "Give the rule a name.").max(MAIL_RULES.nameChars)),
    enabled: z.boolean(),
    match: z.enum(["all", "any"]),
    conditions: z.array(RuleCondition).min(1, "Add a condition.").max(MAIL_RULES.maxConditions),
    actions: RuleActions,
  })
  .strict()
  .refine(
    (r) => r.conditions.every((c) => !("op" in c) || c.op !== "is" || SENDER_ADDRESS.test(c.value.toLowerCase())),
    { message: "“is” needs a whole address, like jane@example.com." },
  );
export type MailRule = z.infer<typeof MailRule>;

export const MailRuleList = z.array(MailRule).max(MAIL_RULES.maxRules);

/** Whether a rule's move action is to a folder that no longer has the path it was saved with. */
export const folderMoved = (rule: MailRule, paths: ReadonlyMap<string, string>): boolean =>
  rule.actions.move?.kind === "folder" && paths.get(rule.actions.move.folderId) !== rule.actions.move.path;

/** A JMAP `Email/query` filter close to a rule's conditions (the preview in Settings; Sieve decides at delivery). */
export function previewFilter(rule: Pick<MailRule, "match" | "conditions">): Record<string, unknown> {
  const conditions = rule.conditions.map((c): Record<string, unknown> => {
    switch (c.field) {
      case "from":
        return { from: c.value };
      case "toCc":
        return { operator: "OR", conditions: [{ to: c.value }, { cc: c.value }] };
      case "subject":
        return { subject: c.value };
      case "listId":
        return { header: ["List-Id", c.value] };
      case "attachment":
        return { hasAttachment: true };
      case "size":
        return c.op === "over" ? { minSize: c.kb * 1024 + 1 } : { maxSize: c.kb * 1024 };
    }
  });
  return conditions.length === 1
    ? (conditions[0] ?? {})
    : { operator: rule.match === "all" ? "AND" : "OR", conditions };
}

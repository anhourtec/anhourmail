// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { hashPassword } from "@anhourmail/adapters/auth";
import { can } from "@anhourmail/core";
import { addUser, PLATFORM_DOMAIN_ID } from "@anhourmail/core/mailboxes";
import { MAILBOX_PASSWORD } from "@anhourmail/shared/security";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { enforceLimit, ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const text = (max: number) => z.string().max(max).optional();

/** Shape only; the service checks every value (and answers 404/403 before looking at them). */
const Create = z.object({
  firstName: text(200),
  lastName: text(200),
  displayName: text(400),
  localPart: text(256),
  domainId: text(64),
  role: text(32),
  quotaGb: z.union([z.string().max(16), z.number()]).optional(),
  generatePassword: z.boolean().optional(),
  // Generous bound so the service can say what's wrong; the rules live in the service.
  password: text(MAILBOX_PASSWORD.max * 4),
  requirePasswordChange: z.boolean().optional(),
  profile: z.record(z.string().max(32), z.string().max(400)).optional(),
});

/**
 * "Add a user" (`mailbox.manage`, and a role the caller may grant): a mailbox plus a console login on that address with
 * the chosen role, in one audited transaction (`addUser`). A generated password is in the response once and nowhere
 * else (never logged or audited). Free platform addresses also spend the per-account and per-client-address budgets.
 */
export const POST = route(
  async ({ req, meta }, params) => {
    const parsed = Create.safeParse((await readJson(req)) ?? {});
    const body = parsed.success ? parsed.data : {};
    const accountId = str(params.accountId);
    const actor = await getActor(req.headers);
    if (body.domainId === PLATFORM_DOMAIN_ID && actor.kind === "user") {
      await enforceLimit("platformMailboxIp", `ip:${meta.ip ?? "direct"}`);
      if (can(actor, "mailbox.manage", accountId)) await enforceLimit("platformMailboxAccount", `account:${accountId}`);
    }
    const added = await addUser(
      container().deps,
      actor,
      accountId,
      {
        firstName: body.firstName,
        lastName: body.lastName,
        displayName: body.displayName,
        localPart: body.localPart,
        domainId: body.domainId,
        role: body.role,
        quotaGb: body.quotaGb,
        generatePassword: body.generatePassword,
        password: body.password,
        requirePasswordChange: body.requirePasswordChange,
        profile: body.profile,
      },
      meta,
      container().passwords,
      hashPassword,
    );
    const res = ok(added, 201);
    // A generated password is in this body: never cache it anywhere.
    res.headers.set("Cache-Control", "no-store");
    return res;
  },
  { limit: "sensitive" },
);

// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { z } from "zod";

import { enforceLimit, ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Open = z.object({
  address: z.email().max(254),
  /**
   * False for a mailbox-scoped tab (Open another mailbox, `/mailbox/<address>/`): the mailbox is opened (or its grant
   * checked, if already open) without becoming the session's active one, so the person's other tabs keep theirs; the
   * tab pins it on every request (`server/webmail/pin.ts`). Default: opened and made active (a "Shared with you" entry).
   */
  activate: z.boolean().optional(),
});

/**
 * Opens a mailbox shared with the person and makes it active (ADR-0026 §6): a "Shared with you" entry, or the address
 * typed in **Open another mailbox**. The grant is checked now and the open audited (`delegation.mailbox_opened`, in the
 * person's own account); the mailbox's tokens are minted for this session only and never reach the browser. No grant,
 * an address that doesn't exist and another account's address all get the same 404 "You don't have access to this
 * mailbox."; 403 while the console session this came from has act-as open; 503 when the mail server was busy. With
 * `activate: false` the session's active mailbox stays as it is (a mailbox-scoped tab; one of the person's own
 * addresses is refused the same way).
 */
export const POST = route(
  async ({ req, meta }) => {
    const id = webmailSessionId(req.headers.get("cookie"));
    if (!id) return unauthorized();
    const parsed = Open.safeParse(await readJson(req));
    if (!parsed.success) return badRequest("Enter a mailbox address.");
    // A second bucket per own mailbox (≈ the person), so signing in again doesn't start a fresh one; fail closed.
    const s = await webmail().store.read(id);
    if (!s) return unauthorized();
    const own = (s.delegated?.via ?? s.username).toLowerCase();
    await enforceLimit(
      "webmailDelegatedOpen",
      `mailbox:${createHash("sha256").update(`delegated-open\0${own}`).digest("base64url").slice(0, 22)}`,
    );
    return handleWebmail(async () => {
      const { address, activate } = parsed.data;
      const s = await webmail().openDelegated(id, address, meta, activate === false ? { activate: false } : {});
      return ok({ active: s.username, activeShared: s.delegated !== undefined });
    });
  },
  { session: "webmail", limit: "webmailDelegatedOpen", delegated: "allowed" },
);

// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { z } from "zod";

import { enforceLimit, ok, readJson, route } from "@/server/http/route";
import { badRequest, handleWebmail, unauthorized } from "@/server/webmail/http";
import { webmail, webmailSessionId } from "@/server/webmail/instance";

const Open = z.object({ address: z.email().max(254) });

/**
 * Opens a mailbox shared with the person and makes it active (ADR-0026 §6): a "Shared with you" entry, or the address
 * typed in **Open another mailbox**. The grant is checked now and the open audited (`delegation.mailbox_opened`, in the
 * person's own account); the mailbox's tokens are minted for this session only and never reach the browser. No grant,
 * an address that doesn't exist and another account's address all get the same 404 "You don't have access to this
 * mailbox."; 403 while the console session this came from has act-as open; 503 when the mail server was busy.
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
      const s = await webmail().openDelegated(id, parsed.data.address, meta);
      return ok({ active: s.username, activeShared: s.delegated !== undefined });
    });
  },
  { session: "webmail", limit: "webmailDelegatedOpen", delegated: "allowed" },
);

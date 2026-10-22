// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson, route } from "@/server/http/route";
import { settingsService } from "@/server/webmail/instance";

/**
 * The owner of a forwarding target confirms it (the button on `/forwarding/confirm/:token`; never on a plain GET,
 * so link scanners can't confirm). Public, fail-closed per address. Unknown, used or expired tokens are 404.
 */
export const POST = route(
  async ({ req, meta }) => {
    const body = (await readJson(req)) as { token?: unknown } | null;
    const out = await settingsService().confirmForwarding(body?.token, meta);
    return ok({ mailbox: out.mailbox });
  },
  { limit: "publicForm" },
);

// SPDX-License-Identifier: AGPL-3.0-only
import { checkDomain } from "@anhourmail/core/domains";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Check every DNS record live; activates the domain when the required ones pass (`domain.manage`). */
export const POST = route(
  async ({ req, meta }, params) =>
    ok(
      await checkDomain(
        container().deps,
        container().dns,
        await getActor(req.headers),
        str(params.accountId),
        str(params.domainId),
        meta,
      ),
    ),
  { limit: "dnsVerify" },
);

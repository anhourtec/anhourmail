// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Daily: the pending custom domains' lifecycle (PENDING_DOMAIN in packages/shared/src/plans.ts). Unverified domains
 * never put on the mail server are deleted once they are too old; ones on the mail server are released (`domain.remove`
 * takes them off it) once too old, or as soon as their ownership or MX record is gone. Each change is audited in the
 * domain's account (`domain.expired`, `domain.released`); a failed DNS lookup releases nothing.
 */
import { expirePendingDomains } from "@anhourmail/core/domains";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, dns, close } = runtime();
const { expired, released, failed } = await expirePendingDomains(deps, dns);
log
  .child({ component: "domain-expiry" })
  .at(failed > 0 ? "warn" : "info", "pending domain expiry finished", { expired, released, failed });
await close();

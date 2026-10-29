// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every minute: closes staff act-as sessions (ADR-0023) that ran out, whose console session ended, or whose staff
 * member lost the role, and records each as `staff.act_as_ended` in the account's log and the platform log. The console
 * already stops honouring them the moment they lapse; this closes the record. Database only (no mail-server key used).
 */
import { expireActAsSessions } from "@anhourmail/core/platform";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const { ended } = await expireActAsSessions(deps);
log.child({ component: "act-as-expiry" }).info("act-as expiry finished", { ended });
await close();

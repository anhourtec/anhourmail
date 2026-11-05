// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail import sweep (hourly, ADR-0030 §2, §16): terminal imports that still hold a sealed secret, a username or a
 * folder name are wiped (their credential's revoke queued); paused or blocked imports whose destination credential
 * expired end as failed; syncing imports past their window end. Database only (the worker's revoke job takes
 * credentials off the mail server). Counts only in the log.
 */
import { expireImports } from "@anhourmail/core/imports";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const report = await expireImports(deps);
log.child({ component: "import-expiry" }).info("import sweep finished", { ...report });
await close();

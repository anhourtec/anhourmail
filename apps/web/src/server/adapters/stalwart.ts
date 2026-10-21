// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { stalwart } from "@anhourmail/stalwart-client";

/** Readiness probe for the mail server (rule 21: Stalwart only through its client, behind this adapter). */
export const stalwartReady = (): Promise<void> => stalwart().ready();

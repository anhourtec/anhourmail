// SPDX-License-Identifier: AGPL-3.0-only
import { DomainError } from "../errors";

export type ImportRefusal = "mailbox_unavailable" | "import_running" | "import_finished";

const MESSAGES: Record<ImportRefusal, string> = {
  mailbox_unavailable:
    "This mailbox can't take an import right now: it's suspended, being deleted, not ready yet, or waiting for its first password change.",
  import_running: "This mailbox already has an import in progress. Wait for it to finish, or cancel it first.",
  import_finished: "This import has already finished.",
};

/** An import can't start or change in this state (HTTP 409 with the reason as its code). */
export class ImportRefusedError extends DomainError {
  constructor(readonly reason: ImportRefusal) {
    super(MESSAGES[reason], reason);
  }
}

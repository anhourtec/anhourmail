// SPDX-License-Identifier: AGPL-3.0-only
import {
  APP_PASSWORD_NAME_MAX,
  APP_PASSWORD_PROTOCOLS,
  type AppPasswordProtocol,
  isAppPasswordProtocol,
} from "@anhourmail/shared/security";

import { ValidationError } from "../errors";

/**
 * An app password a person made for a mail app on one of their mailboxes. The secret lives only in the mail server
 * (hashed there) and in the one response that showed it: this is the metadata. `revoking` while the worker takes it
 * off the mail server; the row goes once that succeeds.
 */
export type AppPasswordStatus = "active" | "revoking";

export type AppPassword = {
  id: string;
  accountId: string;
  mailboxId: string;
  name: string;
  protocols: AppPasswordProtocol[];
  /** The mail server's id for the credential. Ids are reused after a revocation, so it's matched with the time. */
  credentialId: string;
  credentialCreatedAt: Date;
  createdAt: Date;
  /** The console user who made it. */
  createdBy: string | null;
  status: AppPasswordStatus;
};

/** One line, no control characters, 1–40 characters ("Phone", "Work laptop"). */
export function appPasswordName(input: unknown): string {
  const v =
    typeof input === "string"
      ? input
          .replace(/\p{Cc}/gu, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  if (v === "" || v.length > APP_PASSWORD_NAME_MAX) {
    throw new ValidationError(
      `Give it a name of up to ${String(APP_PASSWORD_NAME_MAX)} characters, like the device or app.`,
    );
  }
  return v;
}

/** At least one of the known protocols, each once, in the canonical order. */
export function appPasswordProtocols(input: unknown): AppPasswordProtocol[] {
  const list = Array.isArray(input) ? input : [];
  if (list.length === 0 || !list.every(isAppPasswordProtocol)) {
    throw new ValidationError("Choose what the app password can be used for.");
  }
  return APP_PASSWORD_PROTOCOLS.filter((p) => list.includes(p));
}

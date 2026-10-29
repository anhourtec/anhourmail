// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the data export and account deletion jobs (ADR-0025) need beyond `runtime()`: the key ring that seals export
 * archives (`SECRETS_KEYRING`; the web app opens them with the same ring), the system mailer and the console's address
 * for links. Never the operations key: neither job touches the mail server directly.
 */
import { sealedArchiver } from "@anhourmail/adapters/archive";
import { createMailer, type Mailer } from "@anhourmail/adapters/mail";
import type { ExportArchiver } from "@anhourmail/core/data";
import { keyRingFromEnv } from "@anhourmail/server/keyring";

export function lifecycleDeps(env: Record<string, string | undefined> = process.env): {
  archiver: ExportArchiver;
  mailer: Mailer;
  consoleUrl: string;
} {
  const consoleUrl = (env.APP_URL ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(consoleUrl)) throw new Error("APP_URL is not set");
  if (!env.MAIL_TRANSPORT_URL || !env.MAIL_FROM) throw new Error("MAIL_TRANSPORT_URL and MAIL_FROM must be set");
  const ring = keyRingFromEnv({
    spec: env.SECRETS_KEYRING,
    production: env.NODE_ENV === "production",
    devFallbackSecret: env.BETTER_AUTH_SECRET,
  });
  return {
    archiver: sealedArchiver(ring),
    mailer: createMailer({ url: env.MAIL_TRANSPORT_URL, from: env.MAIL_FROM }),
    consoleUrl,
  };
}

/** Sends one email; a failure is logged by error name only (never the address) and never stops the job. */
export async function sendQuietly(
  mailer: Mailer,
  message: Parameters<Mailer["send"]>[0],
  onError: (errorName: string) => void,
): Promise<boolean> {
  try {
    await mailer.send(message);
    return true;
  } catch (err) {
    onError(err instanceof Error ? err.name : "unknown");
    return false;
  }
}

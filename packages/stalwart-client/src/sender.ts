// SPDX-License-Identifier: MIT
import type { StalwartManagement } from "./management";

/**
 * Sender identity enforcement (ADR-0019). Stalwart's `mustMatchSender` checks only the SMTP envelope, so an
 * authenticated account could show another address in the visible From header — local or external — on mail we
 * DKIM-sign. This Sieve system script runs at DATA for authenticated sessions (SMTP 465/587 and JMAP
 * EmailSubmission, which goes through the same stage) and requires exactly one From address equal to the
 * already-validated envelope sender, and a matching Sender header if one is present.
 *
 * Verified against Stalwart v0.16.27: own address, own alias and a group member sending as the group (envelope and
 * header both the group) are accepted; a forged header From, two From addresses, a forged Sender and a missing
 * From are refused with 5.5.3. Match variables (`${1}`) are not populated in this context, so the script compares
 * against `${envelope.from}` directly.
 */
export const SENDER_IDENTITY_SCRIPT = "sender-identity";

export const SENDER_IDENTITY_SIEVE = `require ["envelope", "variables", "relational", "comparator-i;ascii-numeric", "reject"];

# AnhourMail sender identity (ADR-0019). Runs at DATA for authenticated submissions only (MtaStageData.script).
# mustMatchSender has already checked the envelope sender against the account's own address, aliases and groups;
# here the visible From (and Sender, if present) must be exactly that address.

if not exists "from" {
  reject "A From header is required.";
  stop;
}

if address :count "ne" :comparator "i;ascii-numeric" :all "from" "1" {
  reject "Use exactly one address in the From header.";
  stop;
}

if not address :all :comparator "i;unicode-casemap" :is "from" "\${envelope.from}" {
  reject "The From address must match the address you are sending from.";
  stop;
}

if exists "sender" {
  if not address :all :comparator "i;unicode-casemap" :is "sender" "\${envelope.from}" {
    reject "The Sender address must match the address you are sending from.";
    stop;
  }
}
`;

/** The DATA-stage expression: run the script for authenticated sessions only (inbound MX mail is unaffected). */
export const SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION = {
  match: { "0": { if: "!is_empty(authenticated_as)", then: `'${SENDER_IDENTITY_SCRIPT}'` } },
  else: "false",
} as const;

type ScriptRow = { id: string; name: string; contents?: string; isActive?: boolean };

/**
 * Installs or updates the script and wires it into the DATA stage, keeping `mustMatchSender` on.
 * Idempotent. Callers run `reloadSettings()` afterwards (the DATA-stage expression is compiled).
 */
export async function applySenderIdentityPolicy(mgmt: StalwartManagement): Promise<{ scriptId: string }> {
  const t = mgmt.transport;
  const scripts = await t.getAll<ScriptRow>("x:SieveSystemScript", ["name", "contents", "isActive"]);
  const existing = scripts.find((s) => s.name === SENDER_IDENTITY_SCRIPT);
  let scriptId: string;
  if (existing) {
    scriptId = existing.id;
    if (existing.contents !== SENDER_IDENTITY_SIEVE || existing.isActive !== true) {
      await t.set("x:SieveSystemScript", {
        update: { [existing.id]: { contents: SENDER_IDENTITY_SIEVE, isActive: true } },
      });
    }
  } else {
    const { created } = await t.set("x:SieveSystemScript", {
      create: {
        s: {
          name: SENDER_IDENTITY_SCRIPT,
          description: "Header From and Sender must equal the authenticated envelope sender (ADR-0019)",
          isActive: true,
          contents: SENDER_IDENTITY_SIEVE,
        },
      },
    });
    const id = created.s?.id;
    if (!id) throw new Error("sender-identity script was not created");
    scriptId = id;
  }
  await mgmt.updateSingleton("x:MtaStageData", { script: SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION });
  await mgmt.updateSingleton("x:MtaStageAuth", { mustMatchSender: { match: {}, else: "true" } });
  return { scriptId };
}

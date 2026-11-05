// SPDX-License-Identifier: AGPL-3.0-only
/** Shared fixtures for the mail import tests: an account with every role, mailboxes, step-ups, a fake issuer and sealer. */
import type { Mailbox } from "../mailboxes/entity";
import type { ImportCredentialIssuer } from "../imports/ports";
import type { ImportSealer } from "../imports/secrets";
import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock, user } from "./helpers";

export const MBX_MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const MBX_OWNER = "abababab-abab-4bab-8bab-abababababab";
export const MBX_UADMIN = "efefefef-efef-4fef-8fef-efefefefefef";
export const MBX_SHARED = "acacacac-acac-4cac-8cac-acacacacacac";
export const MBX_PAUSED = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
export const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const SESSION = "session-1";

export const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
export const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
export const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
export const billingAdmin = user({ id: "badmin", account: [[ACCOUNT_A, "billing_admin"]] });
export const auditor = user({ id: "auditor", account: [[ACCOUNT_A, "auditor"]] });
export const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
export const member2 = user({ id: "member2", account: [[ACCOUNT_A, "member"]] });
export const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

/** Seals as readable JSON bound to purpose and AAD; opening with anything else throws (like the key ring). */
export const fakeSealer: ImportSealer & { sealed: string[] } = {
  sealed: [],
  encrypt(purpose, plaintext, aad) {
    const out = `sealed:${Buffer.from(JSON.stringify({ purpose, aad, plaintext })).toString("base64")}`;
    fakeSealer.sealed.push(out);
    return out;
  },
  decrypt(purpose, sealed, aad) {
    const v = JSON.parse(Buffer.from(sealed.replace(/^sealed:/, ""), "base64").toString()) as {
      purpose: string;
      aad: string;
      plaintext: string;
    };
    if (v.purpose !== purpose || v.aad !== aad) throw new Error("does not open");
    return v.plaintext;
  },
};

export type FakeIssuer = ImportCredentialIssuer & {
  minted: { stalwartAccountId: string; id: string; expiresAt: Date }[];
  destroyed: string[];
  fail: boolean;
};

export function fakeIssuer(clock: { now(): Date }): FakeIssuer {
  let n = 0;
  const issuer: FakeIssuer = {
    minted: [],
    destroyed: [],
    fail: false,
    async mint(stalwartAccountId, expiresAt) {
      if (issuer.fail) throw new Error("mail server unavailable");
      n += 1;
      const id = `cred-${String(n)}`;
      issuer.minted.push({ stalwartAccountId, id, expiresAt });
      return { id, createdAt: clock.now(), secret: `app_secret_${String(n)}` };
    },
    async destroy(_account, id) {
      issuer.destroyed.push(id);
    },
  };
  return issuer;
}

/** Account A with every role, its mailboxes (one each, a shared one, a suspended one) and account B with one. */
export function importWorld(iso = "2026-11-05T12:00:00Z") {
  const clock = fixedClock(iso);
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["dadmin", ACCOUNT_A, "domain_admin"],
    ["badmin", ACCOUNT_A, "billing_admin"],
    ["auditor", ACCOUNT_A, "auditor"],
    ["member", ACCOUNT_A, "member"],
    ["member2", ACCOUNT_A, "member"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.ca`;
  }
  const mailbox = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
    id,
    accountId,
    userId,
    address,
    status: "active",
    quotaBytes: 1024 * 1024,
    stalwartId: `s-${id.slice(0, 4)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    mailbox(MBX_MEMBER, ACCOUNT_A, "kid@family.ca", "member"),
    mailbox(MBX_OWNER, ACCOUNT_A, "mum@family.ca", "owner"),
    mailbox(MBX_UADMIN, ACCOUNT_A, "it@family.ca", "uadmin"),
    mailbox(MBX_SHARED, ACCOUNT_A, "shop@family.ca", null),
    { ...mailbox(MBX_PAUSED, ACCOUNT_A, "paused@family.ca", "member2"), status: "suspended" },
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca", "owner-b"),
  );
  for (const userId of ["member", "member2", "owner", "uadmin", "dadmin", "badmin", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(clock.now().getTime() + 60_000) });
  }
  return { d, clock, s, issuer: fakeIssuer(clock) };
}

export const SOURCE = { host: "imap.old-provider.example", port: 993, username: "kid@old.example", password: "app-pw" };

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The credential split against the pinned dev Stalwart (ADR-0020 "Credential split"): the three service accounts with
 * their real keys, each proven to do exactly its job and nothing else. Throwaway domains and accounts, destroyed
 * afterwards. No wrong credential is ever sent (the dev forwarder's address is shared and Stalwart bans after repeated
 * failures); refusals for a missing permission don't count as failures.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  AUDIT_KEY_PERMISSIONS,
  credentialScopeProblems,
  CUSTOMER_PERMISSIONS,
  issueServiceKey,
  OPERATIONS_KEY_PERMISSIONS,
  PROVISIONING_KEY_PERMISSIONS,
  serviceAccountProblems,
  StalwartManagement,
  StalwartTransport,
  SUSPENDED_PERMISSIONS,
  USER_ROLE_PERMISSIONS,
  verifyStalwartCredential,
} from "@anhourmail/stalwart-client";
import { systemClock } from "@anhourmail/core";
import { reconcileServiceAccounts } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { MANAGED_SIEVE_SCRIPT } from "@anhourmail/shared/webmail";

import { hashPassword } from "../auth/password";
import { MemoryUnitOfWork } from "../memory";
import {
  expectedServiceAccounts,
  stalwartAppPasswordInventory,
  stalwartAppPasswords,
  stalwartMailServer,
  stalwartManagedScripts,
  stalwartServiceAccounts,
} from ".";
import { issueTestKeys } from "./int-keys";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need STALWART_URL and the dev Stalwart admin");
}
const adminMgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);

const tag = randomUUID().slice(0, 8);
const domain = `keys-${tag}.test`;
const serviceDomain = `svc-${tag}.test`;
const keys = await issueTestKeys(adminMgmt, stalwartUrl, serviceDomain);
/** RFC 5737 documentation range, random per run: this test's calls don't count against the shared dev client. */
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;

afterAll(async () => {
  for (const u of (await adminMgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await adminMgmt.destroy("x:Account", u.id);
  }
  const d = (await adminMgmt.listDomains()).find((x) => x.name === domain);
  if (d) await adminMgmt.destroyDomain(d.id);
  await keys.cleanup();
});

const CORE = "urn:ietf:params:jmap:core";
const STALWART = "urn:stalwart:jmap";
const MAIL = "urn:ietf:params:jmap:mail";

/** One JMAP call with a key; the answer as its method name, `error:<type>` or `HTTP <status>`. */
async function call(secret: string, using: string[], method: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${stalwartUrl}/jmap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": clientAddress,
    },
    body: JSON.stringify({ using, methodCalls: [[method, args, "c"]] }),
  });
  if (!res.ok) return `HTTP ${String(res.status)}`;
  const [[name, out]] = ((await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] })
    .methodResponses as [[string, Record<string, unknown>, string]];
  if (name === "error") return `error:${String(out.type)}`;
  for (const k of ["notCreated", "notUpdated", "notDestroyed"]) {
    const failed = Object.values((out[k] ?? {}) as Record<string, { type?: string }>)[0];
    if (failed) return `${k}:${failed.type ?? ""}`;
  }
  return name;
}

const download = async (secret: string, accountId: string, blobId: string): Promise<number> =>
  (
    await fetch(`${stalwartUrl}/jmap/download/${accountId}/${blobId}/m`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Forwarded-For": clientAddress },
    })
  ).status;

/** A customer mailbox made with the provisioning key, holding one message (imported by the dev admin). */
const customer = { id: "", blobId: "" };

describe("the credential split on Stalwart", () => {
  it("each key is exactly its documented set, and its account's role caps it", async () => {
    expect(await verifyStalwartCredential("provisioning", keys.provisioning)).toBe("key");
    expect(await verifyStalwartCredential("operations", keys.operations)).toBe("key");
    expect(await verifyStalwartCredential("audit", keys.audit)).toBe("key");
    for (const role of ["provisioning", "operations", "audit"] as const) {
      expect(await serviceAccountProblems(adminMgmt, role, keys.domainId)).toEqual([]);
    }
    // The wrong key for a role is refused by the start-up check.
    expect(credentialScopeProblems("provisioning", await keys.operations.credentialPermissions())).not.toEqual([]);
    // A key minted with more than its account's role (here `impersonate` on the provisioning account) still can't use
    // it: the role caps it.
    const wider = await issueServiceKey(adminMgmt, "audit", keys.accountIds.provisioning, {
      description: "wider than the role",
      allowedIps: [],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const widerMgmt = new StalwartManagement(
      new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "bearer", token: wider } }),
    );
    expect(await widerMgmt.credentialPermissions()).not.toContain("impersonate");
  });

  it("the User role is still the one the provisioning key was built from (upgrade guard)", async () => {
    const name = `role-${tag}`;
    const password = `${randomBytes(18).toString("base64url")}-Aa1`;
    const id = await adminMgmt.upsertUser({
      name,
      domain: serviceDomain,
      password: await hashPassword(password),
      quotaBytes: 1e7,
    });
    await adminMgmt.transport.set("x:Account", { update: { [id]: { permissions: { "@type": "Inherit" } } } });
    const res = await fetch(`${stalwartUrl}/api/account`, {
      headers: { Authorization: `Basic ${Buffer.from(`${name}@${serviceDomain}:${password}`).toString("base64")}` },
    });
    const perms = ((await res.json()) as { permissions: string[] }).permissions;
    expect([...perms].sort()).toEqual([...USER_ROLE_PERMISSIONS]);
    await adminMgmt.destroy("x:Account", id);
  });

  it("provisioning key: creates and locks customer mailboxes, revokes credentials, never reads a mailbox", async () => {
    const mail = stalwartMailServer(keys.provisioning);
    await mail.ensureDomain(domain);
    customer.id = (
      await mail.ensureMailbox({
        externalId: null,
        initialPasswordHash: null,
        address: `owner@${domain}`,
        quotaBytes: 50 * 1024 * 1024,
        suspended: false,
        aliases: [{ address: `hello@${domain}`, enabled: true, description: null }],
      })
    ).externalId;
    const listed = (await mail.listMailboxes()).find((m) => m.address === `owner@${domain}`);
    expect(listed).toMatchObject({ suspended: false, sieveLocked: true });
    await mail.ensureMailbox({
      externalId: customer.id,
      initialPasswordHash: null,
      address: `owner@${domain}`,
      quotaBytes: 1e8,
      suspended: true,
      aliases: [],
    });
    expect((await mail.listMailboxes()).find((m) => m.address === `owner@${domain}`)?.suspended).toBe(true);
    await mail.ensureMailbox({
      externalId: customer.id,
      initialPasswordHash: null,
      address: `owner@${domain}`,
      quotaBytes: 1e8,
      suspended: false,
      aliases: [],
    });

    // A message in the mailbox (the dev admin imports it), so blob access can be tried with a real id.
    const blobId = await adminMgmt.transport.uploadBlob(
      customer.id,
      "message/rfc822",
      `From: a@${domain}\r\nTo: owner@${domain}\r\nSubject: keys\r\n\r\nbody\r\n`,
    );
    const boxes = await adminMgmt.transport.rawCall(
      [CORE, MAIL],
      [["Mailbox/get", { accountId: customer.id, properties: ["role"] }, "m"]],
    );
    const inbox = ((boxes.get("m")?.list ?? []) as { id: string; role?: string }[]).find((b) => b.role === "inbox");
    const imported = await adminMgmt.transport.rawCall(
      [CORE, MAIL],
      [
        [
          "Email/import",
          { accountId: customer.id, emails: { e: { blobId, mailboxIds: { [inbox?.id ?? ""]: true } } } },
          "i",
        ],
      ],
    );
    customer.blobId = String((imported.get("i")?.created as Record<string, { blobId: string }>).e?.blobId);

    const p = keys.secrets.provisioning;
    const on = customer.id;
    expect(await call(p, [CORE, MAIL], "Email/query", { accountId: on })).toBe("error:forbidden");
    expect(await call(p, [CORE, MAIL], "Mailbox/get", { accountId: on })).toBe("error:forbidden");
    expect(
      await call(p, [CORE, "urn:ietf:params:jmap:blob"], "Blob/get", { accountId: on, ids: [customer.blobId] }),
    ).toBe("error:forbidden");
    expect(await download(p, on, customer.blobId)).toBe(404);
    expect(await call(p, [CORE, "urn:ietf:params:jmap:sieve"], "SieveScript/get", { accountId: on })).toBe(
      "error:forbidden",
    );
    expect(await call(p, [CORE, STALWART], "x:AppPassword/get", { accountId: on, ids: null })).toBe("error:forbidden");
    expect(
      await call(p, [CORE, STALWART], "x:AppPassword/set", {
        accountId: on,
        create: { a: { description: "x", permissions: { "@type": "Disable", permissions: {} } } },
      }),
    ).toBe("error:forbidden");
    expect(await call(p, [CORE, "urn:ietf:params:jmap:principals"], "Principal/query", {})).toBe("error:forbidden");
    expect(await call(p, [CORE, STALWART], "x:SystemSettings/get", { ids: ["singleton"] })).toBe("error:forbidden");
    expect(await call(p, [CORE, STALWART], "x:Role/set", { create: { r: { description: "x" } } })).toBe(
      "error:forbidden",
    );
    // It can't hand out more than a customer keeps.
    for (const update of [
      { roles: { "@type": "Admin" } },
      { permissions: { "@type": "Inherit" } },
      { permissions: { "@type": "Merge", enabledPermissions: { impersonate: true }, disabledPermissions: {} } },
    ]) {
      expect(await call(p, [CORE, STALWART], "x:Account/set", { update: { [on]: update } })).toBe(
        "notUpdated:forbidden",
      );
    }
    expect(
      await call(p, [CORE, STALWART], "x:Account/set", { update: { [on]: { permissions: SUSPENDED_PERMISSIONS } } }),
    ).toBe("x:Account/set");
    expect(
      await call(p, [CORE, STALWART], "x:Account/set", { update: { [on]: { permissions: CUSTOMER_PERMISSIONS } } }),
    ).toBe("x:Account/set");
  });

  it("operations key: app passwords and the managed script on a mailbox, nothing in the directory", async () => {
    const issuer = stalwartAppPasswords(keys.operations);
    const made = await issuer.create({ externalId: customer.id, name: "Phone", protocols: ["imap"] });
    expect(made.secret).toMatch(/^app_[a-z0-9]{36}$/);
    // The provisioning key sees it in the account's credentials and revokes it there (the revoke job's path).
    const inventory = await stalwartAppPasswordInventory(keys.provisioning).list(customer.id);
    expect(inventory.appPasswords).toEqual([
      { credentialId: made.credentialId, createdAt: made.createdAt, protocols: ["imap"] },
    ]);
    await stalwartMailServer(keys.provisioning).revokeAppPassword({ externalId: customer.id, ...made });
    expect((await stalwartAppPasswordInventory(keys.provisioning).list(customer.id)).appPasswords).toEqual([]);
    // Undo-a-create with owner access, as the web app does when recording fails.
    const second = await issuer.create({ externalId: customer.id, name: "Laptop", protocols: ["smtp"] });
    await issuer.revoke({ externalId: customer.id, ...second });
    expect(await keys.operations.listAppPasswords(customer.id)).toEqual([]);

    await keys.operations.putSieveScript(customer.id, MANAGED_SIEVE_SCRIPT, 'require ["fileinto"];\nkeep;\n');
    expect(await keys.operations.getSieveScript(customer.id, MANAGED_SIEVE_SCRIPT)).toMatchObject({ active: true });

    const o = keys.secrets.operations;
    const on = customer.id;
    expect(await call(o, [CORE, STALWART], "x:Account/get", { ids: null, properties: ["name"] })).toBe(
      "error:forbidden",
    );
    expect(
      await call(o, [CORE, STALWART], "x:Account/set", {
        create: { n: { "@type": "User", name: "nope", domainId: keys.domainId, credentials: {} } },
      }),
    ).toBe("error:forbidden");
    expect(
      await call(o, [CORE, STALWART], "x:Account/set", { update: { [on]: { quotas: { maxDiskQuota: 1 } } } }),
    ).toBe("error:forbidden");
    expect(await call(o, [CORE, STALWART], "x:Domain/get", { ids: null })).toBe("error:forbidden");
    expect(await call(o, [CORE, STALWART], "x:Domain/set", { create: { d: { name: "nope.test" } } })).toBe(
      "error:forbidden",
    );
    expect(await call(o, [CORE, STALWART], "x:DkimSignature/get", { ids: null })).toBe("error:forbidden");
    expect(await call(o, [CORE, MAIL], "Email/query", { accountId: on })).toBe("error:forbidden");
    expect(await call(o, [CORE, MAIL], "Mailbox/get", { accountId: on })).toBe("error:forbidden");
    expect(
      await call(o, [CORE, "urn:ietf:params:jmap:blob", MAIL], "Blob/lookup", {
        accountId: on,
        typeNames: ["Email"],
        ids: [customer.blobId],
      }),
    ).toBe("error:forbidden");
    expect(
      await call(o, [CORE, STALWART], "x:ApiKey/set", {
        accountId: on,
        create: { k: { description: "x", permissions: { "@type": "Disable", permissions: {} } } },
      }),
    ).toBe("error:forbidden");
    // Known and accepted (ADR-0020): with `jmapBlobGet` it downloads a blob whose id it already has. It can't list or
    // look one up (above). Re-verified on every upgrade by this line.
    expect(await download(o, on, customer.blobId)).toBe(200);
  });

  it("audit key: reads the managed script and nothing else", async () => {
    const reader = stalwartManagedScripts(keys.audit);
    expect(await reader.read(customer.id)).toMatchObject({ active: true });
    await expect(keys.audit.putSieveScript(customer.id, MANAGED_SIEVE_SCRIPT, "keep;\n")).rejects.toThrow();
    const a = keys.secrets.audit;
    const on = customer.id;
    expect(
      await call(a, [CORE, "urn:ietf:params:jmap:sieve"], "SieveScript/set", {
        accountId: on,
        onSuccessDeactivateScript: true,
      }),
    ).toBe("error:forbidden");
    expect(await call(a, [CORE, MAIL], "Email/query", { accountId: on })).toBe("error:forbidden");
    expect(await call(a, [CORE, STALWART], "x:AppPassword/get", { accountId: on, ids: null })).toBe("error:forbidden");
    expect(await call(a, [CORE, STALWART], "x:Account/get", { ids: null })).toBe("error:forbidden");
    expect(await call(a, [CORE, STALWART], "x:Domain/get", { ids: null })).toBe("error:forbidden");
  });

  it("the reconciler sees a password set on a service account (the provisioning key can set one)", async () => {
    const deps = { uow: new MemoryUnitOfWork(), clock: systemClock, platform: PUBLIC_PLATFORM };
    const inventory = stalwartServiceAccounts(keys.provisioning, [serviceDomain]);
    const expected = expectedServiceAccounts();
    const listed = await inventory.list();
    expect(listed.domains).toEqual([serviceDomain]);
    expect(listed.accounts.map((a) => `${a.name}:${a.credentials.join("+")}`).sort()).toEqual([
      "svc-audit:ApiKey",
      "svc-ops:ApiKey",
      "svc-provision:ApiKey+ApiKey", // the second is the "wider" key of the first test
    ]);
    expect(await reconcileServiceAccounts(deps, inventory, expected)).toMatchObject({ checked: 3, clean: true });
    // The infrastructure domain is also the platform domain (free addresses, ADR-0021): a customer mailbox and the
    // system mailboxes there, each with a password, are neither service accounts nor drift.
    for (const name of ["jane.free", "no-reply", "postmaster"]) {
      await adminMgmt.upsertUser({
        name,
        domain: serviceDomain,
        password: await hashPassword(randomBytes(24).toString("base64url")),
        quotaBytes: 1024 ** 2,
      });
    }
    expect((await inventory.list()).accounts.map((a) => a.name).sort()).toEqual([
      "svc-audit",
      "svc-ops",
      "svc-provision",
    ]);
    expect(await reconcileServiceAccounts(deps, inventory, expected)).toMatchObject({ checked: 3, clean: true });
    // No infrastructure domain configured must not pass with checked: 0.
    expect(
      await reconcileServiceAccounts(deps, stalwartServiceAccounts(keys.provisioning, []), expected),
    ).toMatchObject({ misconfigured: true, clean: false });
    // Not preventable at the mail server on Community (the management proxy refuses it in production): the provisioning
    // key adds a password to the operations account, which would then sign in with `impersonate`. Reported within the
    // minute.
    await keys.provisioning.transport.set("x:Account", {
      update: {
        [keys.accountIds.operations]: {
          "credentials/9": { "@type": "Password", secret: await hashPassword(randomBytes(24).toString("base64url")) },
        },
      },
    });
    expect(await reconcileServiceAccounts(deps, inventory, expected)).toMatchObject({ withPassword: 1, clean: false });
    // Another domain's mailbox with the same name isn't a service account; expected accounts then read as missing.
    const other = await reconcileServiceAccounts(deps, stalwartServiceAccounts(keys.provisioning, [domain]), expected);
    expect(other.missing.sort()).toEqual([...expected].sort());
  });

  it("documents the sets the keys were built from", () => {
    expect(PROVISIONING_KEY_PERMISSIONS).not.toContain("impersonate");
    expect(OPERATIONS_KEY_PERMISSIONS).toContain("impersonate");
    expect(AUDIT_KEY_PERMISSIONS).toHaveLength(5);
  });
});

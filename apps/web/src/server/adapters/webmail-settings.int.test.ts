// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail settings against the real dev Stalwart (`npm run test:int`): automatic replies, forwarding after the
 * target confirmed, and blocked senders, all through the managed Sieve script. Three throwaway `dev.test` mailboxes
 * per run (removed afterwards), so nothing touches the demo mailboxes and the mail server's per-recipient throttle
 * starts fresh. Mail never leaves the dev network (rule 19). The control plane side (confirmation, audit) runs on the
 * in-memory adapter with the forwarding mailbox seeded.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import type { MailMessage } from "@anhourmail/adapters/mail";
import { systemClock } from "@anhourmail/core";
import { WebmailSettingsService } from "@anhourmail/core/webmail";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { createKeyRing } from "@anhourmail/server/keyring";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailService } from "../webmail/service";
import { WebmailSettings } from "../webmail/settings";
import { DEFAULT_RULES, MANAGED_SCRIPT } from "../webmail/sieve";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const run = randomBytes(4).toString("hex");
const req = { requestId: `int-settings-${run}`, ip: null, userAgent: "vitest" };

type Box = { name: string; address: string; password: string; id: string | null };
const box = (role: string): Box => ({
  name: `int-${role}-${run}`,
  address: `int-${role}-${run}@dev.test`,
  password: randomBytes(18).toString("base64url"),
  id: null,
});
/** The mailbox with the settings, someone writing to it, and the forwarding target. */
const owner = box("owner");
const sender = box("sender");
const target = box("target");

beforeAll(async () => {
  for (const b of [owner, sender, target]) {
    b.id = await stalwartDevAdmin().upsertUser({
      name: b.name,
      domain: "dev.test",
      password: await hashPassword(b.password),
      quotaBytes: 50 * 1024 * 1024,
      // As provisioning does: a customer mailbox can't write its own Sieve (CUSTOMER_PERMISSIONS).
      suspended: false,
    });
  }
});
afterAll(async () => {
  for (const b of [owner, sender, target]) if (b.id) await stalwartDevAdmin().destroy("x:Account", b.id);
});

/** The control-plane settings service the mail service asks for the confirmed forwarding target (set below). */
let confirmedSource: WebmailSettingsService | null = null;

function mailService() {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    stalwartUrl: STALWART_URL,
    access: { allowed: async () => true },
    quota: memorySlidingQuota(),
    sieve: {
      read: (accountId) => stalwartDevAdmin().getSieveScript(accountId, MANAGED_SCRIPT),
      write: (accountId, script) => stalwartDevAdmin().putSieveScript(accountId, MANAGED_SCRIPT, script),
    },
    confirmedForward: async (address) => {
      const f = await confirmedSource?.forwarding(address);
      return f?.status === "confirmed" ? f.address : null;
    },
    defer: () => undefined,
  });
}

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

/** Waits until `who` has a message whose subject contains `subject`; returns the folder roles it is in. */
async function waitFor(svc: WebmailService, sessionId: string, subject: string): Promise<string[]> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const res = (await svc.jmapAs(sessionId, (s) => ({
      using: USING,
      methodCalls: [
        ["Email/query", { accountId: s.accountId, filter: { subject } }, "q"],
        [
          "Email/get",
          {
            accountId: s.accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["mailboxIds"],
          },
          "g",
        ],
        ["Mailbox/get", { accountId: s.accountId, properties: ["role"] }, "m"],
      ],
    }))) as { methodResponses: [string, Record<string, unknown>, string][] };
    const list = (res.methodResponses[1]?.[1].list ?? []) as { mailboxIds: Record<string, boolean> }[];
    const roles = new Map(
      ((res.methodResponses[2]?.[1].list ?? []) as { id: string; role: string | null }[]).map((m) => [m.id, m.role]),
    );
    if (list.length > 0) return list.flatMap((e) => Object.keys(e.mailboxIds).map((id) => roles.get(id) ?? "folder"));
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}

async function send(svc: WebmailService, sessionId: string, from: string, to: string, subject: string) {
  const identity = (await svc.identities(sessionId)).find((i) => i.email === from);
  if (!identity) throw new Error("identity missing");
  const draft = await svc.saveDraft(sessionId, {
    identityId: identity.id,
    to: [{ name: null, email: to }],
    cc: [],
    bcc: [],
    subject,
    text: "Hello from the settings integration test.",
    attachments: [],
  });
  await svc.send(sessionId, draft.id, identity.id);
}

describe("webmail settings on the dev Stalwart", () => {
  const mail = mailService();
  const uow = new MemoryUnitOfWork();
  const sent: MailMessage[] = [];
  const core = new WebmailSettingsService({ uow, clock: systemClock, platform: PUBLIC_PLATFORM });
  confirmedSource = core;
  const settings = new WebmailSettings({
    mail,
    settings: core,
    mailer: { send: async (m) => void sent.push(m) },
    webmailUrl: WEBMAIL_URL,
  });
  let ownerSession = "";
  let senderSession = "";
  let targetSession = "";
  let account = "";

  beforeAll(async () => {
    uow.state.mailboxes.push({
      id: randomUUID(),
      accountId: randomUUID(),
      userId: null,
      address: owner.address,
      status: "active",
      quotaBytes: 50 * 1024 * 1024,
      stalwartId: owner.id,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    });
    ownerSession = (await mail.signIn(owner.address, owner.password)).sessionId;
    senderSession = (await mail.signIn(sender.address, sender.password)).sessionId;
    targetSession = (await mail.signIn(target.address, target.password)).sessionId;
    account = (await settings.overview(ownerSession)).accountId;
  });

  it("sends an automatic reply to someone who writes in", async () => {
    await settings.saveVacation(
      ownerSession,
      account,
      {
        vacation: {
          enabled: true,
          from: null,
          to: null,
          subject: `Away ${run}`,
          message: 'Back on Monday. "Quotes" and \\ backslashes stay text.',
          contactsOnly: false,
        },
        timeZone: "America/Vancouver",
      },
      req,
    );
    const overview = await settings.overview(ownerSession);
    expect(overview.rulesState).toBe("active");
    expect(overview.rules.vacation).toMatchObject({ enabled: true, subject: `Away ${run}` });
    expect(uow.state.audit.at(-1)).toMatchObject({ action: "vacation.changed", meta: { enabled: true } });

    await send(mail, senderSession, sender.address, owner.address, `int-vacation ${run}`);
    expect(await waitFor(mail, senderSession, `Away ${run}`)).toContain("inbox");

    await settings.saveVacation(
      ownerSession,
      account,
      { vacation: { ...DEFAULT_RULES.vacation }, timeZone: "UTC" },
      req,
    );
    expect((await settings.overview(ownerSession)).rules.vacation.enabled).toBe(false);
  }, 60_000);

  it("files mail from a blocked sender in Junk", async () => {
    await settings.saveJunk(ownerSession, account, { blocked: [sender.address], safe: [], trustedOnly: false }, req);
    await send(mail, senderSession, sender.address, owner.address, `int-blocked ${run}`);
    expect(await waitFor(mail, ownerSession, `int-blocked ${run}`)).toEqual(["junk"]);
    await settings.saveJunk(ownerSession, account, { blocked: [], safe: [], trustedOnly: false }, req);
  }, 60_000);

  it("forwards only after the target confirms, keeping a copy", async () => {
    // Not before confirmation.
    await expect(settings.setForwarding(ownerSession, account, { enabled: true, keepCopy: true }, req)).rejects.toThrow(
      /confirms/,
    );
    const asked = await settings.requestForwarding(ownerSession, account, target.address, req);
    expect(asked).toEqual({ target: target.address, emailed: true });
    const link = /\/forwarding\/confirm\/([A-Za-z0-9_-]{43})/.exec(sent.at(-1)?.text ?? "")?.[1];
    expect(sent.at(-1)?.to).toBe(target.address);
    if (!link) throw new Error("no confirmation link");
    await new WebmailSettingsService({ uow, clock: systemClock, platform: PUBLIC_PLATFORM }).confirmForwarding(
      link,
      req,
    );

    await settings.setForwarding(ownerSession, account, { enabled: true, keepCopy: true }, req);
    expect(uow.state.audit.at(-1)).toMatchObject({ action: "forwarding.changed", meta: { enabled: true } });
    await send(mail, senderSession, sender.address, owner.address, `int-forward ${run}`);
    expect(await waitFor(mail, targetSession, `int-forward ${run}`)).toContain("inbox");
    expect(await waitFor(mail, ownerSession, `int-forward ${run}`)).toContain("inbox");

    await settings.removeForwarding(ownerSession, account, req);
    expect((await settings.overview(ownerSession)).rules.forwarding).toMatchObject({ enabled: false, address: null });
  }, 90_000);

  it("refuses a user VacationResponse (it would switch our rules off for the server's own script)", async () => {
    const res = (await mail.jmapAs(ownerSession, (s) => ({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:vacationresponse"],
      methodCalls: [
        [
          "VacationResponse/set",
          { accountId: s.accountId, update: { singleton: { isEnabled: true, textBody: "x" } } },
          "v",
        ],
      ],
    }))) as { methodResponses: [string, Record<string, unknown>, string][] };
    expect(res.methodResponses[0]?.[0]).toBe("error");
    expect(res.methodResponses[0]?.[1].type).toBe("forbidden");
  }, 60_000);

  it("refuses a user switching the rules off; rules switched off otherwise show as inactive and come back", async () => {
    await settings.saveJunk(ownerSession, account, { blocked: ["spam.example"], safe: [], trustedOnly: false }, req);
    // With `jmapSieveScriptDestroy` denied too, a bare deactivate is refused for the user (verified run-22).
    const refused = (await mail.jmapAs(ownerSession, (s) => ({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"],
      methodCalls: [["SieveScript/set", { accountId: s.accountId, onSuccessDeactivateScript: true }, "s"]],
    }))) as { methodResponses: [string, Record<string, unknown>, string][] };
    expect(refused.methodResponses[0]?.[0]).toBe("error");
    expect(refused.methodResponses[0]?.[1].type).toBe("forbidden");
    expect((await settings.overview(ownerSession)).rulesState).toBe("active");
    // Switched off some other way (here by hand with the dev admin): shown as inactive, and a save turns it back on.
    // (Only the web app's operations key can: the worker has no owner access; the reconciler reports it.)
    const deactivate = () =>
      stalwartDevAdmin().transport.rawCall(
        ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"],
        [["SieveScript/set", { accountId: account, onSuccessDeactivateScript: true }, "s"]],
      );
    await deactivate();
    expect((await settings.overview(ownerSession)).rulesState).toBe("inactive");
    await settings.saveJunk(ownerSession, account, { blocked: [], safe: [], trustedOnly: false }, req);
    expect((await settings.overview(ownerSession)).rulesState).toBe("active");
  }, 60_000);

  it("refuses a user writing their own Sieve: the managed script can't be bypassed", async () => {
    // The relay vector (NV-1): a variable redirect to a per-message target. The mailbox token may upload the blob
    // (attachments need that) but SieveScript/set is forbidden, so no user script can be installed or activated.
    const blob = await mail.upload(
      ownerSession,
      new TextEncoder().encode('require ["variables"];\nif header :matches "X-T" "*" { redirect "${1}"; }\n'),
      "application/sieve",
    );
    const res = (await mail.jmapAs(ownerSession, (s) => ({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"],
      methodCalls: [
        [
          "SieveScript/set",
          {
            accountId: s.accountId,
            create: { m: { name: "mine", blobId: blob.blobId } },
            onSuccessActivateScript: "#m",
          },
          "s",
        ],
      ],
    }))) as { methodResponses: [string, Record<string, unknown>, string][] };
    const call = res.methodResponses[0];
    const forbidden =
      call?.[0] === "error" ||
      Object.keys((call?.[1].notCreated as Record<string, unknown> | undefined) ?? {}).length > 0;
    expect(forbidden).toBe(true);
    // Only our managed script exists (written with management credentials), and it's the active one.
    const scripts = (await mail.jmapAs(ownerSession, (s) => ({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"],
      methodCalls: [["SieveScript/get", { accountId: s.accountId, properties: ["name", "isActive"] }, "g"]],
    }))) as { methodResponses: [string, { list: { name: string; isActive: boolean }[] }, string][] };
    const names = (scripts.methodResponses[0]?.[1].list ?? []).map((x) => x.name);
    expect(names).not.toContain("mine");
  }, 60_000);
});

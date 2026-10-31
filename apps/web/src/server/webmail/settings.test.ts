// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { NotFoundError } from "@anhourmail/core";
import type { MailMessage } from "@anhourmail/adapters/mail";
import { setWebmailSenderName, webmailSenderName, webmailSendingNames } from "@anhourmail/core/people";
import { WebmailSettingsService, WebmailSignaturesService } from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { checkJmapRequest } from "./jmap-policy";
import {
  GrantRefusedError,
  WebmailConflictError,
  WebmailRefusedError,
  WebmailSenderBlockedError,
  WebmailService,
} from "./service";
import { memoryKv, WebmailSessionStore } from "./session-store";
import {
  SAFE_SENDER_UNVERIFIED,
  SAFE_SENDERS_FULL,
  SafeSenderInput,
  SenderNameChange,
  WebmailSettings,
} from "./settings";
import { buildScript, DEFAULT_RULES, parseScript } from "./sieve";

const MAIL = "urn:ietf:params:jmap:mail";
const req = { requestId: "r1", ip: null, userAgent: null };

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

type Script = { id: string; name: string; blobId: string; isActive: boolean };

/** A small mail server: identities, quota, Sieve scripts with blobs, contact cards. */
function fakeServer() {
  const state = {
    identities: new Map([
      ["i1", { id: "i1", name: "a@x.test", email: "a@x.test", textSignature: "", htmlSignature: "" }],
      ["i2", { id: "i2", name: "Hello", email: "hello@x.test", textSignature: "Hi there", htmlSignature: "" }],
    ]),
    scripts: [] as Script[],
    blobs: new Map<string, string>(),
    cards: new Map<string, { id: string; emails: Record<string, { address: string }> }>(),
    /** Messages for `Email/get` (from + headers). */
    emails: new Map<string, { id: string; from: { email: string }[]; headers: { name: string; value: string }[] }>(),
    refuseScripts: false,
    refuseIdentity: false,
    seq: 0,
  };
  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    "Identity/get": () => ({ list: [...state.identities.values()] }),
    "Identity/set": (a) => {
      const updated: Record<string, null> = {};
      for (const [id, patch] of Object.entries(a.update as Record<string, Record<string, string>>)) {
        const i = state.identities.get(id);
        if (!i || state.refuseIdentity) continue;
        Object.assign(i, patch);
        updated[id] = null;
      }
      return { updated };
    },
    "Quota/get": () => ({
      list: [
        { resourceType: "count", scope: "account", used: 4, hardLimit: 100 },
        { resourceType: "octets", scope: "account", used: 1234, hardLimit: 5000 },
      ],
    }),
    "SieveScript/get": () => ({ list: state.scripts.map((s) => ({ ...s })) }),
    "SieveScript/set": (a) => {
      if (state.refuseScripts) {
        return a.create
          ? { notCreated: { s: { type: "invalidScript" } } }
          : { notUpdated: { [Object.keys(a.update as object)[0] ?? ""]: { type: "invalidScript" } } };
      }
      const created: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries((a.create ?? {}) as Record<string, { name: string; blobId: string }>)) {
        const id = `sc${String(++state.seq)}`;
        state.scripts.push({ id, name: v.name, blobId: v.blobId, isActive: false });
        created[k] = { id };
      }
      const updated: Record<string, null> = {};
      for (const [id, patch] of Object.entries((a.update ?? {}) as Record<string, { blobId: string }>)) {
        const s = state.scripts.find((x) => x.id === id);
        if (s) {
          s.blobId = patch.blobId;
          updated[id] = null;
        }
      }
      const activate = typeof a.onSuccessActivateScript === "string" ? a.onSuccessActivateScript : null;
      if (activate) {
        const target = activate.startsWith("#") ? created[activate.slice(1)]?.id : activate;
        for (const s of state.scripts) s.isActive = s.id === target;
      }
      return { created, updated };
    },
    "ContactCard/query": () => ({ ids: [...state.cards.keys()], total: state.cards.size }),
    "ContactCard/get": (a) => ({ list: (a.ids as string[]).map((id) => state.cards.get(id)).filter(Boolean) }),
    "ContactCard/set": (a) => {
      const created: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries(
        (a.create ?? {}) as Record<string, { emails: Record<string, { address: string }> }>,
      )) {
        const id = `ct${String(++state.seq)}`;
        state.cards.set(id, { id, emails: v.emails });
        created[k] = { id };
      }
      return { created };
    },
    "AddressBook/get": () => ({ list: [{ id: "b", name: "Book", isDefault: true }] }),
    "Email/get": (a) => ({
      list: (a.ids as string[]).flatMap((id) => {
        const e = state.emails.get(id);
        return e ? [e] : [];
      }),
    }),
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/jmap/session")) {
      return Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } });
    }
    if (url.includes("/jmap/upload/")) {
      const blobId = `blob${String(++state.seq)}`;
      state.blobs.set(blobId, new TextDecoder().decode(init?.body as Uint8Array));
      return Response.json({ blobId, size: 1 });
    }
    if (url.includes("/jmap/download/")) {
      const blobId = decodeURIComponent(url.split("/jmap/download/acc1/")[1]?.split("/")[0] ?? "");
      const text = state.blobs.get(blobId);
      return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    return Response.json({
      methodResponses: body.methodCalls.map(([name, args, id]) => {
        const h = handlers[name];
        return h ? [name, h(args), id] : ["error", { type: "unknownMethod" }, id];
      }),
    });
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function setup() {
  const fake = fakeServer();
  // The managed Sieve script, read/written with management credentials in production; an in-memory map here.
  const managed = new Map<string, string>();
  const sieveFail = { fail: false };
  /** The mail server answers a read without a Sieve state. */
  const noState = { on: false };
  /** The account's Sieve state (a counter), moved on by every write. */
  const versions = new Map<string, number>();
  /** Runs just before the next reads (one each): a concurrent change between reads. */
  const beforeRead: (() => void)[] = [];
  /** Runs just before the next writes (one each): a concurrent change. */
  const beforeWrite: (() => void)[] = [];
  const writes: string[] = [];
  const written: { accountId: string; address: string }[] = [];
  /** What the next "Always for" / "Stop loading" reads as the message's From (null: the session can't see it). */
  const messages = new Map<string, { from: string | null; verified: boolean }>();
  /** Accounts whose managed script a user switched off. */
  const inactive = new Set<string>();
  /** Makes the control-plane sender-name lookup fail (the database unreachable). */
  const namesDown = { down: false };
  const confirmedSource: { core?: WebmailSettingsService } = {};
  const uow = new MemoryUnitOfWork();
  const deps = { uow, clock: { now: () => new Date() }, platform: PUBLIC_PLATFORM };
  const svc = new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "k", key: randomBytes(32) }])),
    oauth: {
      signIn: async (_n, secret) => {
        if (secret !== "right") throw new GrantRefusedError("no");
        return { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 };
      },
      refresh: async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 }),
    },
    stalwartUrl: "http://stalwart",
    access: { state: async () => "ok" as const },
    quota: memorySlidingQuota(),
    sieve: {
      read: async (accountId) => {
        beforeRead.shift()?.();
        const content = managed.get(accountId);
        const state = noState.on ? "" : String(versions.get(accountId) ?? 0);
        return content === undefined ? null : { content, active: !inactive.has(accountId), state };
      },
      write: async (accountId, script, ifInState) => {
        if (sieveFail.fail) throw new Error("sieve refused");
        // Another window's save landing between this change's read and its write.
        const meanwhile = beforeWrite.shift();
        if (meanwhile) meanwhile();
        if (ifInState === null && managed.has(accountId)) return false;
        // A blind compare (no state given at the read) never lands, as on the real client.
        if (typeof ifInState === "string" && (ifInState === "" || ifInState !== String(versions.get(accountId) ?? 0)))
          return false;
        managed.set(accountId, script);
        versions.set(accountId, (versions.get(accountId) ?? 0) + 1);
        inactive.delete(accountId);
        writes.push(accountId);
        return true;
      },
    },
    rulesWritten: async (accountId, address) => {
      written.push({ accountId, address });
    },
    confirmedForward: async (address) => {
      const f = await confirmedSource.core?.forwarding(address);
      return f?.status === "confirmed" ? f.address : null;
    },
    fetch: fake.fetchImpl,
    defer: () => undefined,
    senderName: (address) => {
      if (namesDown.down) return Promise.reject(new Error("database unreachable"));
      return webmailSendingNames(deps, address);
    },
  });
  const { sessionId } = await svc.signIn("a@x.test", "right");
  // The mailbox belongs to Ada, a member of its account only: its sender name is her name (rule 61).
  const accountId = randomUUID();
  const mailboxId = randomUUID();
  uow.state.userEmails.ada = "ada@console.test";
  uow.state.userNames.ada = "Ada Lovelace";
  uow.state.memberships.push({ userId: "ada", accountId, role: "member" });
  uow.state.mailboxes.push({
    id: mailboxId,
    accountId,
    userId: "ada",
    address: "a@x.test",
    status: "active",
    quotaBytes: 1,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(),
  });
  const sent: MailMessage[] = [];
  const mailer = {
    fail: false,
    send: async (m: MailMessage) => {
      if (mailer.fail) throw new Error("smtp down");
      sent.push(m);
    },
  };
  const core = new WebmailSettingsService(deps);
  confirmedSource.core = core;
  const signatures = new WebmailSignaturesService({ uow, clock: { now: () => new Date() }, platform: PUBLIC_PLATFORM });
  const settings = new WebmailSettings({
    mail: svc,
    settings: core,
    signatures,
    senderNames: {
      get: (address) => webmailSenderName(deps, address),
      set: (address, input, r) => setWebmailSenderName(deps, address, input, r),
    },
    mailer,
    messageSender: async (_sessionId, emailId) => messages.get(emailId) ?? null,
    webmailUrl: "https://mail.example/",
    siteHost: "example.test",
  });
  const script = () => managed.get("acc1") ?? "";
  return {
    svc,
    sessionId,
    uow,
    accountId,
    mailboxId,
    sent,
    mailer,
    core,
    signatures,
    settings,
    script,
    managed,
    sieveFail,
    noState,
    inactive,
    namesDown,
    versions,
    beforeWrite,
    beforeRead,
    writes,
    written,
    messages,
    ...fake,
  };
}

describe("settings in the mail server", () => {
  it("reads storage from the octets quota", async () => {
    const t = await setup();
    expect(await t.svc.quota(t.sessionId)).toEqual({ used: 1234, limit: 5000 });
  });

  it("names every identity with the mailbox's sender name from the control plane, renaming them on the server", async () => {
    const t = await setup();
    const list = await t.svc.identities(t.sessionId);
    expect(list.map((i) => i.name)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    // Renamed on the mail server too (the session's own token), signatures untouched.
    expect(t.state.identities.get("i1")).toMatchObject({ name: "Ada Lovelace", textSignature: "" });
    expect(t.state.identities.get("i2")).toMatchObject({ name: "Ada Lovelace", textSignature: "Hi there" });
    // A change in the control plane (the console Profile) shows on the next read, inside the cache minute.
    t.uow.state.userNames.ada = "Ada King";
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["Ada King", "Ada King"]);
    expect(t.state.identities.get("i2")?.name).toBe("Ada King");
  });

  it("gives a masked alias no name, on the server too, while a plain alias keeps the sender name", async () => {
    const t = await setup();
    const alias = (address: string, kind: "alias" | "masked") => ({
      id: randomUUID(),
      accountId: t.accountId,
      mailboxId: t.mailboxId,
      address,
      kind,
      enabled: true,
      adminLocked: false,
      description: null,
      createdAt: new Date(),
    });
    t.uow.state.aliases.push(alias("hello@x.test", "masked"));
    t.state.identities.set("i3", {
      id: "i3",
      name: "Shop",
      email: "shop@x.test",
      textSignature: "",
      htmlSignature: "",
    });
    t.uow.state.aliases.push(alias("shop@x.test", "alias"));
    expect((await t.svc.identities(t.sessionId)).map((i) => [i.email, i.name])).toEqual([
      ["a@x.test", "Ada Lovelace"],
      ["hello@x.test", ""],
      ["shop@x.test", "Ada Lovelace"],
    ]);
    expect(t.state.identities.get("i2")).toMatchObject({ name: "", textSignature: "Hi there" });
    expect(t.state.identities.get("i3")?.name).toBe("Ada Lovelace");
    // A new name in the control plane renames the address and the plain alias, never the masked one.
    t.uow.state.userNames.ada = "Ada King";
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["Ada King", "", "Ada King"]);
    expect(t.state.identities.get("i2")?.name).toBe("");
  });

  it("sends with no name at all while the control plane can't be read, never the mail server's names", async () => {
    const t = await setup();
    // The mail server still names every identity after the person (e.g. a masked alias not yet renamed).
    const i2 = t.state.identities.get("i2");
    if (!i2) throw new Error("no identity");
    t.state.identities.set("i2", { ...i2, name: "Ada Lovelace" });
    t.namesDown.down = true;
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["", ""]);
    // Nothing renamed on the server and nothing cached: the next read with the control plane back has the real names.
    expect(t.state.identities.get("i2")?.name).toBe("Ada Lovelace");
    t.namesDown.down = false;
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
  });

  it("follows an admin's custom display name, and none clears the names", async () => {
    const t = await setup();
    const box = t.uow.state.mailboxes.find((m) => m.id === t.mailboxId);
    if (!box) throw new Error("no mailbox");
    box.displayName = "Support desk";
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["Support desk", "Support desk"]);
    box.displayName = null;
    box.userId = null;
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["", ""]);
    expect(t.state.identities.get("i2")?.name).toBe("");
  });

  it("still sends as the control-plane name when the server refuses the rename, and tries again", async () => {
    const t = await setup();
    t.state.refuseIdentity = true;
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    expect(t.state.identities.get("i2")?.name).toBe("Hello");
    t.state.refuseIdentity = false;
    expect((await t.svc.refreshIdentities(t.sessionId, "acc1")).map((i) => i.name)).toEqual([
      "Ada Lovelace",
      "Ada Lovelace",
    ]);
    expect(t.state.identities.get("i2")?.name).toBe("Ada Lovelace");
  });

  it("shows the sender name in the overview, and refuses a change the webmail may not make", async () => {
    const t = await setup();
    expect((await t.settings.overview(t.sessionId)).sender).toEqual({
      name: "Ada Lovelace",
      source: "person",
      editable: true,
    });
    await expect(t.settings.updateSenderName(t.sessionId, "acc2", { name: "X" }, req)).rejects.toThrow(
      /active mailbox/,
    );
    // An admin's custom display name is read-only here (403, audited as denied; the person's name is untouched).
    const box = t.uow.state.mailboxes.find((m) => m.id === t.mailboxId);
    if (!box) throw new Error("no mailbox");
    box.displayName = "Support desk";
    expect((await t.settings.overview(t.sessionId)).sender).toMatchObject({
      name: "Support desk",
      source: "custom",
      editable: false,
      reason: expect.stringMatching(/admin/) as unknown,
    });
    await expect(t.settings.updateSenderName(t.sessionId, "acc1", { name: "X" }, req)).rejects.toThrow(/admin/);
    expect(t.uow.state.audit.at(-1)).toMatchObject({
      action: "account.profile_changed",
      result: "denied",
      errorCode: "admin_set",
    });
    expect(t.uow.state.userNames.ada).toBe("Ada Lovelace");
    // In another account too: changed only from the console.
    box.displayName = null;
    t.uow.state.memberships.push({ userId: "ada", accountId: randomUUID(), role: "member" });
    await expect(t.settings.updateSenderName(t.sessionId, "acc1", { name: "X" }, req)).rejects.toThrow(/console/);
    expect(t.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "other_account" });
  });

  it("leaves identities alone for an address the control plane doesn't hold", async () => {
    const t = await setup();
    t.uow.state.mailboxes.length = 0;
    expect((await t.svc.identities(t.sessionId)).map((i) => i.name)).toEqual(["a@x.test", "Hello"]);
  });

  it("writes and reads back the one managed script with management credentials", async () => {
    const t = await setup();
    expect(await t.svc.mailRules(t.sessionId)).toEqual({
      accountId: "acc1",
      rules: DEFAULT_RULES,
      state: "none",
      version: null,
    });

    const { include: _i, ...base } = DEFAULT_RULES;
    await t.svc.saveMailRules(t.sessionId, "acc1", {
      ...base,
      junk: { blocked: ["spam.example"], safe: [], trustedOnly: false },
    });
    // The script went to the managed store (management credentials), not the JMAP mail state over the user token.
    expect(t.managed.get("acc1")).toContain("fileinto");
    expect(t.state.scripts).toHaveLength(0);
    const read = await t.svc.mailRules(t.sessionId);
    expect(read.state).toBe("active");
    expect(read.rules.junk.blocked).toEqual(["spam.example"]);
    // The script never includes a user script (users can't write Sieve).
    expect(t.script()).not.toContain("include :personal");
    expect(parseScript(t.script())?.include).toBeNull();

    await expect(t.svc.saveMailRules(t.sessionId, "acc2", base)).rejects.toThrow(/active mailbox/);
    t.sieveFail.fail = true;
    await expect(t.svc.saveMailRules(t.sessionId, "acc1", base)).rejects.toThrow(/didn't accept/);
  });

  it("falls back to re-reading and comparing the text when the server gives no Sieve state", async () => {
    const t = await setup();
    t.noState.on = true;
    await t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: ["a.example"], trustedOnly: false }, req);
    await t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: ["b.example"], trustedOnly: false }, req);
    expect(parseScript(t.script())?.junk.safe).toEqual(["b.example"]);
    expect((await t.svc.mailRules(t.sessionId)).version).toMatch(/^content-sha256:/);
    // Another window changes the text between this save's read and its write: 409, and its change stays.
    // (The second read is the compare right before the write.)
    t.beforeRead.push(
      () => undefined,
      () => {
        t.managed.set("acc1", `${t.script()}# changed meanwhile\n`);
      },
    );
    await expect(
      t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: [], trustedOnly: false }, req),
    ).rejects.toBeInstanceOf(WebmailConflictError);
    expect(t.beforeRead).toEqual([]);
    expect(t.script()).toContain("# changed meanwhile");
  });

  it("reads a message's From for Safe senders only when it has exactly one From address", async () => {
    const t = await setup();
    const headers = [{ name: "Subject", value: " Hi " }];
    t.state.emails.set("one", { id: "one", from: [{ email: " news@shop.example " }], headers });
    t.state.emails.set("two", { id: "two", from: [{ email: "news@shop.example" }, { email: "x@y.example" }], headers });
    expect(await t.svc.ownMessageSender(t.sessionId, "one")).toEqual({
      accountId: "acc1",
      from: "news@shop.example",
      headers: [{ name: "Subject", value: "Hi" }],
    });
    expect((await t.svc.ownMessageSender(t.sessionId, "two"))?.from).toBeNull();
    expect(await t.svc.ownMessageSender(t.sessionId, "gone")).toBeNull();
  });

  it("writes on the version it read, refuses a stale one (409), and reports every write's mailbox", async () => {
    const t = await setup();
    const { include: _i, ...base } = DEFAULT_RULES;
    const junk = { blocked: [], safe: ["jane@example.com"], trustedOnly: false };
    await t.svc.saveMailRules(t.sessionId, "acc1", { ...base, junk }, { ifInState: null });
    expect(t.written).toEqual([{ accountId: "acc1", address: "a@x.test" }]);
    const read = await t.svc.mailRules(t.sessionId);
    expect(read.version).toBe("1");
    // A script created meanwhile, or any write since the read: nothing is written.
    await expect(t.svc.saveMailRules(t.sessionId, "acc1", base, { ifInState: null })).rejects.toBeInstanceOf(
      WebmailConflictError,
    );
    await t.svc.saveMailRules(t.sessionId, "acc1", base);
    await expect(
      t.svc.saveMailRules(t.sessionId, "acc1", { ...base, junk }, { ifInState: read.version ?? null }),
    ).rejects.toThrow(/changed in another window/);
    expect(parseScript(t.script())?.junk.safe).toEqual([]);
    expect(t.written).toHaveLength(2);
  });

  it("reports rules a user switched off as inactive; the next save turns them back on", async () => {
    const t = await setup();
    const { include: _i, ...base } = DEFAULT_RULES;
    await t.svc.saveMailRules(t.sessionId, "acc1", base);
    t.inactive.add("acc1");
    expect((await t.svc.mailRules(t.sessionId)).state).toBe("inactive");
    await t.svc.saveMailRules(t.sessionId, "acc1", base);
    expect((await t.svc.mailRules(t.sessionId)).state).toBe("active");
  });

  it("keeps a redirect only to the confirmed target, whoever writes the rules (contacts refresh included)", async () => {
    const t = await setup();
    const { include: _i, ...base } = DEFAULT_RULES;
    const tampered = { ...base, forwarding: { enabled: true, address: "evil@example.org", keepCopy: true } };
    // No confirmed target at all: never written.
    await t.svc.saveMailRules(t.sessionId, "acc1", tampered);
    expect(t.script()).not.toContain("redirect");
    // A script comment that names another address (and trusted-only, so a contact change rewrites it): the refresh
    // goes through the same filter.
    const { token } = await t.core.requestForwarding(
      "a@x.test",
      { target: "copy@example.org", ownAddresses: [], tier: "new" },
      req,
    );
    await t.core.confirmForwarding(token, req);
    t.managed.set(
      "acc1",
      t
        .script()
        .replace(
          /^# am-settings: .*$/m,
          `# am-settings: ${Buffer.from(JSON.stringify({ v: 1, ...DEFAULT_RULES, forwarding: tampered.forwarding, junk: { blocked: [], safe: [], trustedOnly: true } })).toString("base64url")}`,
        ),
    );
    await t.svc.createContact(t.sessionId, "acc1", {
      given: "New",
      surname: "",
      name: "",
      emails: [{ address: "new@example.org", label: "" }],
      phones: [],
      organization: "",
      notes: "",
      birthday: null,
      labels: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.script()).toContain('"new@example.org"'); // the refresh ran
    expect(t.script()).not.toContain("evil@example.org");
    // The confirmed target is kept.
    await t.svc.saveMailRules(t.sessionId, "acc1", {
      ...base,
      forwarding: { enabled: true, address: "copy@example.org", keepCopy: true },
    });
    expect(t.script()).toContain('redirect :copy "copy@example.org";');
  });

  it("puts contacts into 'trusted only' rules and follows contact changes", async () => {
    const t = await setup();
    t.state.cards.set("c1", { id: "c1", emails: { e: { address: "Friend@Example.org" } } });
    const { include: _i, ...base } = DEFAULT_RULES;
    expect(
      await t.svc.saveMailRules(t.sessionId, "acc1", { ...base, junk: { blocked: [], safe: [], trustedOnly: true } }),
    ).toEqual({ contactsUsed: 1 });
    expect(t.script()).toContain('"friend@example.org"');
    await t.svc.createContact(t.sessionId, "acc1", {
      given: "New",
      surname: "",
      name: "",
      emails: [{ address: "new@example.org", label: "" }],
      phones: [],
      organization: "",
      notes: "",
      birthday: null,
      labels: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.script()).toContain('"new@example.org"');
  });

  it("refuses rules too large for the mail server", async () => {
    const t = await setup();
    const many = Array.from(
      { length: 300 },
      (_, i) => `${"x".repeat(60)}.${"y".repeat(60)}.${"z".repeat(60)}${String(i)}.example`,
    );
    const { include: _i, ...base } = DEFAULT_RULES;
    await expect(
      t.svc.saveMailRules(t.sessionId, "acc1", { ...base, junk: { blocked: many, safe: many, trustedOnly: false } }),
    ).rejects.toBeInstanceOf(WebmailRefusedError);
  });

  it("never lets the JMAP proxy write rules, replies, identities or quotas", () => {
    for (const [name, cap] of [
      ["SieveScript/set", "urn:ietf:params:jmap:sieve"],
      ["VacationResponse/set", "urn:ietf:params:jmap:vacationresponse"],
      ["Identity/set", "urn:ietf:params:jmap:submission"],
      ["Quota/get", "urn:ietf:params:jmap:quota"],
    ] as const) {
      expect(
        checkJmapRequest(
          { using: ["urn:ietf:params:jmap:core", cap], methodCalls: [[name, { accountId: "acc1" }, "x"]] },
          "acc1",
        ).ok,
      ).toBe(false);
      expect(
        checkJmapRequest(
          { using: ["urn:ietf:params:jmap:core", MAIL], methodCalls: [[name, { accountId: "acc1" }, "x"]] },
          "acc1",
        ).ok,
      ).toBe(false);
    }
  });
});

describe("webmail settings: control plane and mail server together", () => {
  it("gives the settings window everything for the mailbox", async () => {
    const t = await setup();
    const o = await t.settings.overview(t.sessionId);
    expect(o).toMatchObject({
      accountId: "acc1",
      address: "a@x.test",
      quota: { used: 1234, limit: 5000 },
      rulesState: "none",
      forwardingTarget: null,
    });
    expect(o.identities.map((i) => i.email)).toEqual(["a@x.test", "hello@x.test"]);
    expect((await t.settings.updatePreferences(t.sessionId, "acc1", { density: "roomy" }, req)).density).toBe("roomy");
    await expect(t.settings.updatePreferences(t.sessionId, "acc2", { density: "compact" }, req)).rejects.toThrow(
      /active mailbox/,
    );
    expect((await t.settings.preferences(t.sessionId)).density).toBe("roomy");
  });

  it("saves automatic replies and junk rules and audits them without content", async () => {
    const t = await setup();
    await t.settings.saveVacation(
      t.sessionId,
      "acc1",
      {
        vacation: {
          enabled: true,
          from: "2026-11-01",
          to: null,
          subject: "Away",
          message: "Secret plans",
          contactsOnly: false,
        },
        // A zone without daylight saving, so the expected offset doesn't depend on the machine's time zone data
        // (runners disagree about the day a daylight-saving change happens).
        timeZone: "Asia/Kolkata",
      },
      req,
    );
    expect(t.script()).toContain('currentdate :zone "+0530" :value "ge" "date" "2026-11-01"');
    const vac = t.uow.state.audit.at(-1);
    expect(vac).toMatchObject({
      action: "vacation.changed",
      meta: { enabled: true, dated: true, contactsOnly: false },
    });
    expect(JSON.stringify(vac)).not.toContain("Secret plans");
    await t.settings.saveJunk(
      t.sessionId,
      "acc1",
      { blocked: ["bad@spam.example"], safe: [], trustedOnly: false },
      req,
    );
    const junk = t.uow.state.audit.at(-1);
    expect(junk).toMatchObject({ action: "junk_rules.changed", meta: { blocked: 1, safe: 0, trustedOnly: false } });
    expect(JSON.stringify(junk)).not.toContain("bad@spam.example");
    const named = await t.settings.updateSenderName(t.sessionId, "acc1", { name: "Sam Lee" }, req);
    expect(named.sender).toMatchObject({ name: "Sam Lee", source: "person", editable: true });
    expect(named.identities.map((i) => i.name)).toEqual(["Sam Lee", "Sam Lee"]);
    expect(t.uow.state.userNames.ada).toBe("Sam Lee");
    const renamed = t.uow.state.audit.at(-1);
    expect(renamed).toMatchObject({
      action: "account.profile_changed",
      result: "success",
      meta: { fields: ["name"], self: true, via: "webmail" },
    });
    expect(JSON.stringify(renamed)).not.toContain("Sam Lee");
    await expect(
      t.settings.saveJunk(t.sessionId, "acc2", { blocked: [], safe: [], trustedOnly: false }, req),
    ).rejects.toThrow(/active mailbox/);
  });

  it("audits a Settings save of the junk lists as made in Settings, and refuses one made on a stale read", async () => {
    const t = await setup();
    await t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: ["a.example"], trustedOnly: false }, req);
    expect(t.uow.state.audit.at(-1)).toMatchObject({
      action: "junk_rules.changed",
      result: "success",
      meta: { via: "settings", blocked: 0, safe: 1, trustedOnly: false },
    });
    // "Always for" in the reader lands between this save's read and its write: this save answers 409.
    t.beforeWrite.push(() => {
      t.versions.set("acc1", (t.versions.get("acc1") ?? 0) + 1);
    });
    await expect(
      t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: [], trustedOnly: false }, req),
    ).rejects.toBeInstanceOf(WebmailConflictError);
    expect(parseScript(t.script())?.junk.safe).toEqual(["a.example"]);
  });

  it("adds a message's verified From to Safe senders and removes it again, audited with counts and kinds only", async () => {
    const t = await setup();
    t.messages.set("m1", { from: "News@Shop.example", verified: true });
    expect(await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "add", req)).toEqual({
      safeSender: { kind: "address", value: "news@shop.example" },
      changed: true,
    });
    expect(parseScript(t.script())?.junk.safe).toEqual(["news@shop.example"]);
    const added = t.uow.state.audit.at(-1);
    expect(added).toMatchObject({
      action: "junk_rules.changed",
      result: "success",
      meta: { via: "message", change: "added", kind: "address", blocked: 0, safe: 1, trustedOnly: false },
    });
    expect(JSON.stringify(added?.meta)).not.toContain("@");
    expect(JSON.stringify(added?.meta)).not.toContain("shop.example");
    expect(t.written.at(-1)).toEqual({ accountId: "acc1", address: "a@x.test" });
    // Adding it again changes nothing (no write, no audit).
    const writes = t.writes.length;
    const audits = t.uow.state.audit.length;
    expect((await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "add", req)).changed).toBe(false);
    expect(t.writes.length).toBe(writes);
    expect(t.uow.state.audit.length).toBe(audits);

    expect(await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "remove", req)).toEqual({
      safeSender: null,
      changed: true,
    });
    expect(parseScript(t.script())?.junk.safe).toEqual([]);
    expect(t.uow.state.audit.at(-1)).toMatchObject({
      meta: { via: "message", change: "removed", kind: "address", safe: 0 },
    });
    // Nothing left to remove: a no-op.
    expect((await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "remove", req)).changed).toBe(false);
  });

  it("treats an address its domain already covers as safe, and Stop loading removes the domain entry", async () => {
    const t = await setup();
    await t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: ["shop.example"], trustedOnly: false }, req);
    t.messages.set("m1", { from: "news@shop.example", verified: true });
    expect(await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "add", req)).toEqual({
      safeSender: { kind: "domain", value: "shop.example" },
      changed: false,
    });
    expect(parseScript(t.script())?.junk.safe).toEqual(["shop.example"]);
    await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "remove", req);
    expect(parseScript(t.script())?.junk.safe).toEqual([]);
    expect(t.uow.state.audit.at(-1)).toMatchObject({ meta: { change: "removed", kind: "domain" } });
  });

  it("refuses an unseen message (404), an unverified From or a full list (400), and a blocked sender (409)", async () => {
    const t = await setup();
    await expect(t.settings.changeSafeSender(t.sessionId, "acc1", "nope", "add", req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    t.messages.set("forged", { from: "news@shop.example", verified: false });
    // A From whose domain isn't plain ASCII is never added, whatever the verification said (it checked another form).
    t.messages.set("lookalike", { from: "news@shop\u3002example", verified: true });
    await expect(t.settings.changeSafeSender(t.sessionId, "acc1", "lookalike", "add", req)).rejects.toThrow(
      SAFE_SENDER_UNVERIFIED,
    );
    t.messages.set("nobody", { from: null, verified: true });
    for (const id of ["forged", "nobody"]) {
      await expect(t.settings.changeSafeSender(t.sessionId, "acc1", id, "add", req)).rejects.toThrow(
        SAFE_SENDER_UNVERIFIED,
      );
      await expect(t.settings.changeSafeSender(t.sessionId, "acc1", id, "remove", req)).rejects.toBeInstanceOf(
        WebmailRefusedError,
      );
    }
    t.messages.set("m1", { from: "news@shop.example", verified: true });
    await t.settings.saveJunk(t.sessionId, "acc1", { blocked: ["shop.example"], safe: [], trustedOnly: false }, req);
    const blocked = t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "add", req);
    await expect(blocked).rejects.toBeInstanceOf(WebmailSenderBlockedError);
    await expect(blocked).rejects.toThrow("news@shop.example is on your blocked list. Remove it there first.");
    const full = Array.from({ length: 300 }, (_, i) => `s${String(i)}.example`);
    await t.settings.saveJunk(t.sessionId, "acc1", { blocked: [], safe: full, trustedOnly: false }, req);
    await expect(t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "add", req)).rejects.toThrow(SAFE_SENDERS_FULL);
    // Aimed at another mailbox than the active one.
    await expect(t.settings.changeSafeSender(t.sessionId, "acc2", "m1", "add", req)).rejects.toThrow(/active mailbox/);
    expect(parseScript(t.script())?.junk.safe).toHaveLength(300);
  });

  it("applies the change once more on what is there when another window saved meanwhile, then answers 409", async () => {
    const t = await setup();
    t.messages.set("m1", { from: "news@shop.example", verified: true });
    const other = () => {
      // Another window adds a domain between this change's read and its write.
      const rules = parseScript(t.script()) ?? DEFAULT_RULES;
      const next = { ...rules, junk: { ...rules.junk, safe: [...rules.junk.safe, "other.example"] } };
      t.managed.set(
        "acc1",
        buildScript(next, { identities: [], contacts: [], authservIds: [], mailboxDomain: "x.test" }),
      );
      t.versions.set("acc1", (t.versions.get("acc1") ?? 0) + 1);
    };
    t.beforeWrite.push(other);
    await t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "add", req);
    expect(parseScript(t.script())?.junk.safe).toEqual(["other.example", "news@shop.example"]);
    // Twice in a row: nothing written by this change, 409.
    t.beforeWrite.push(other, other);
    await expect(t.settings.changeSafeSender(t.sessionId, "acc1", "m1", "remove", req)).rejects.toThrow(
      /changed in another window/,
    );
    expect(parseScript(t.script())?.junk.safe).toContain("news@shop.example");
  });

  it("forwards only to a confirmed target, and a new request turns the old forwarding off", async () => {
    const t = await setup();
    await expect(t.settings.setForwarding(t.sessionId, "acc1", { enabled: true, keepCopy: true }, req)).rejects.toThrow(
      /confirms/,
    );
    await expect(t.settings.requestForwarding(t.sessionId, "acc1", "hello@x.test", req)).rejects.toThrow(/own/);
    expect(await t.settings.requestForwarding(t.sessionId, "acc1", "Copy@Example.org", req)).toEqual({
      target: "copy@example.org",
      emailed: true,
    });
    const mail = t.sent.at(-1);
    expect(mail?.to).toBe("copy@example.org");
    // The mailbox address is masked in the email (the full address shows on the confirm page).
    expect(mail?.text).toContain("a***@x.test");
    expect(mail?.text).not.toContain("a@x.test");
    const token = /forwarding\/confirm\/([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1] ?? "";
    expect(mail?.text).toContain(`https://mail.example/forwarding/confirm/${token}`);
    // Still pending: can't be turned on.
    await expect(t.settings.setForwarding(t.sessionId, "acc1", { enabled: true, keepCopy: true }, req)).rejects.toThrow(
      /confirms/,
    );
    await t.core.confirmForwarding(token, req);
    expect(await t.settings.setForwarding(t.sessionId, "acc1", { enabled: true, keepCopy: false }, req)).toEqual({
      enabled: true,
      address: "copy@example.org",
      keepCopy: false,
    });
    expect(t.script()).toContain('redirect "copy@example.org";');
    expect(t.uow.state.audit.at(-1)).toMatchObject({
      action: "forwarding.changed",
      meta: { enabled: true, keepCopy: false, forwardTo: "c***@example.org" },
    });

    // Asking for another address stops forwarding to the old one at once; a failed email is reported.
    t.mailer.fail = true;
    expect(await t.settings.requestForwarding(t.sessionId, "acc1", "other@example.org", req)).toEqual({
      target: "other@example.org",
      emailed: false,
    });
    expect(t.script()).not.toContain("redirect");

    await t.settings.removeForwarding(t.sessionId, "acc1", req);
    expect((await t.settings.overview(t.sessionId)).forwardingTarget).toBeNull();
  });

  it("validates sender names (signatures are named signatures now, not identity fields)", () => {
    expect(SenderNameChange.parse({ name: ' Sam "S" <x>\n' })).toEqual({ name: "Sam S x" });
    expect(SenderNameChange.safeParse({ signature: "Hi" }).success).toBe(false);
    expect(SenderNameChange.safeParse({}).success).toBe(false);
    expect(SenderNameChange.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });

  it("takes only a message id for a Safe senders change, never an address", () => {
    expect(SafeSenderInput.safeParse({ emailId: "Ma1b2" }).success).toBe(true);
    expect(SafeSenderInput.safeParse({ emailId: "Ma1b2", address: "x@y.example" }).success).toBe(false);
    expect(SafeSenderInput.safeParse({ emailId: "a@b.example" }).success).toBe(false);
    expect(SafeSenderInput.safeParse({}).success).toBe(false);
  });
});

describe("signatures", () => {
  const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(12).fill(0)]).toString("base64")}`;

  it("brings the old plain-text signature over once, as the default for both", async () => {
    const t = await setup();
    const first = await t.settings.signatures(t.sessionId, req);
    // i1 (the mailbox's own address) has none, so the alias's "Hi there" is brought over.
    expect(first.signatures).toEqual([
      { id: first.defaults.newMessage, name: "Signature", html: "<div>Hi there</div>", text: "Hi there" },
    ]);
    expect(first.defaults.reply).toBe(first.defaults.newMessage);
    // Read again: the same one, not a second copy.
    expect((await t.settings.signatures(t.sessionId, req)).signatures).toHaveLength(1);
    await t.settings.removeSignature(t.sessionId, "acc1", first.defaults.newMessage ?? "", req);
    expect((await t.settings.signatures(t.sessionId, req)).signatures).toEqual([]);
    expect(JSON.stringify(t.uow.state.audit)).not.toContain("Hi there");
  });

  it("sanitises on save, keeps embedded images, refuses remote ones, and mirrors the new-message default", async () => {
    const t = await setup();
    t.state.identities.get("i2")!.textSignature = "";
    const made = await t.settings.createSignature(
      t.sessionId,
      "acc1",
      {
        name: "Work",
        html: `<p onclick="x()"><b>Sam</b></p><img src="https://tracker.example/p.gif"><img src="${PNG}"><script>x</script>`,
      },
      req,
    );
    const work = made.signatures[0];
    expect(work?.html).toBe(`<p><b>Sam</b></p><img src="${PNG}" />`);
    expect(work?.text).toBe("Sam");
    expect(made.mirrored).toBe(true);
    // Every identity of the mailbox carries the default for new messages.
    for (const id of ["i1", "i2"]) {
      expect(t.state.identities.get(id)).toMatchObject({ htmlSignature: work?.html, textSignature: "Sam" });
    }
    await expect(
      t.settings.createSignature(
        t.sessionId,
        "acc1",
        { name: "Big", html: `<img src="${PNG}${"A".repeat(90_000)}">` },
        req,
      ),
    ).rejects.toThrow(/up to 64 KB/);

    // A second signature as the default for new messages: mirrored; "(No signature)" clears the identities.
    const home = await t.settings.createSignature(t.sessionId, "acc1", { name: "Home", html: "<p>Home</p>" }, req);
    const homeId = home.signatures.find((s) => s.name === "Home")?.id ?? null;
    await t.settings.setSignatureDefaults(t.sessionId, "acc1", { newMessage: homeId, reply: work?.id ?? null }, req);
    expect(t.state.identities.get("i1")).toMatchObject({ htmlSignature: "<p>Home</p>", textSignature: "Home" });
    await t.settings.setSignatureDefaults(t.sessionId, "acc1", { newMessage: null, reply: null }, req);
    expect(t.state.identities.get("i1")).toMatchObject({ htmlSignature: "", textSignature: "" });

    // A refused mirror is reported, not fatal: the signature is still saved.
    t.state.refuseIdentity = true;
    const out = await t.settings.setSignatureDefaults(t.sessionId, "acc1", { newMessage: homeId, reply: null }, req);
    expect(out).toMatchObject({ mirrored: false, defaults: { newMessage: homeId } });
    expect(JSON.stringify(t.uow.state.audit)).not.toMatch(/Sam|Home</);
  });

  it("refuses a change aimed at another mailbox than the active one", async () => {
    const t = await setup();
    await expect(t.settings.createSignature(t.sessionId, "acc2", { name: "X", html: "<p>x</p>" }, req)).rejects.toThrow(
      /active mailbox/,
    );
    await expect(t.settings.signatures("no-such-session", req)).rejects.toThrow(/signed out/);
  });
});

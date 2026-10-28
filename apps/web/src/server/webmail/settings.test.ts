// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import type { MailMessage } from "@anhourmail/adapters/mail";
import { WebmailSettingsService } from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { checkJmapRequest } from "./jmap-policy";
import { GrantRefusedError, signatureHtml, WebmailRefusedError, WebmailService } from "./service";
import { memoryKv, WebmailSessionStore } from "./session-store";
import { IdentityChange, WebmailSettings } from "./settings";
import { DEFAULT_RULES, parseScript } from "./sieve";

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
  /** Accounts whose managed script a user switched off. */
  const inactive = new Set<string>();
  const confirmedSource: { core?: WebmailSettingsService } = {};
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
        const content = managed.get(accountId);
        return content === undefined ? null : { content, active: !inactive.has(accountId) };
      },
      write: async (accountId, script) => {
        if (sieveFail.fail) throw new Error("sieve refused");
        managed.set(accountId, script);
        inactive.delete(accountId);
      },
    },
    confirmedForward: async (address) => {
      const f = await confirmedSource.core?.forwarding(address);
      return f?.status === "confirmed" ? f.address : null;
    },
    fetch: fake.fetchImpl,
    defer: () => undefined,
  });
  const { sessionId } = await svc.signIn("a@x.test", "right");
  const uow = new MemoryUnitOfWork();
  uow.state.mailboxes.push({
    id: randomUUID(),
    accountId: randomUUID(),
    userId: null,
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
  const core = new WebmailSettingsService({ uow, clock: { now: () => new Date() }, platform: PUBLIC_PLATFORM });
  confirmedSource.core = core;
  const settings = new WebmailSettings({
    mail: svc,
    settings: core,
    mailer,
    webmailUrl: "https://mail.example/",
    siteHost: "example.test",
  });
  const script = () => managed.get("acc1") ?? "";
  return { svc, sessionId, uow, sent, mailer, core, settings, script, managed, sieveFail, inactive, ...fake };
}

describe("settings in the mail server", () => {
  it("reads storage from the octets quota", async () => {
    const t = await setup();
    expect(await t.svc.quota(t.sessionId)).toEqual({ used: 1234, limit: 5000 });
  });

  it("changes the sender name and signature of own identities only, with an escaped HTML twin", async () => {
    const t = await setup();
    const out = await t.svc.updateIdentity(t.sessionId, "acc1", "i1", { name: "Sam", signature: "Sam <b>\nCo & co" });
    expect(out).toMatchObject({ id: "i1", name: "Sam", signature: "Sam <b>\nCo & co" });
    expect(t.state.identities.get("i1")).toMatchObject({
      name: "Sam",
      textSignature: "Sam <b>\nCo & co",
      htmlSignature: "<div>Sam &lt;b&gt;<br>Co &amp; co</div>",
    });
    // The composer's identities now carry it.
    expect((await t.svc.identities(t.sessionId)).find((i) => i.id === "i1")?.signature).toBe("Sam <b>\nCo & co");
    await expect(t.svc.updateIdentity(t.sessionId, "acc1", "other", { name: "x" })).rejects.toThrow(
      /isn't one of yours/,
    );
    await expect(t.svc.updateIdentity(t.sessionId, "acc2", "i1", { name: "x" })).rejects.toThrow(/active mailbox/);
    t.state.refuseIdentity = true;
    await expect(t.svc.updateIdentity(t.sessionId, "acc1", "i1", { name: "x" })).rejects.toThrow(/wasn't saved/);
    expect(signatureHtml("")).toBe("");
  });

  it("writes and reads back the one managed script with management credentials", async () => {
    const t = await setup();
    expect(await t.svc.mailRules(t.sessionId)).toEqual({ accountId: "acc1", rules: DEFAULT_RULES, state: "none" });

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
    await t.settings.updateIdentity(t.sessionId, "acc1", "i1", { signature: "Sam" }, req);
    expect(t.uow.state.audit.at(-1)).toMatchObject({ action: "identity.changed", meta: { fields: ["signature"] } });
    await expect(
      t.settings.saveJunk(t.sessionId, "acc2", { blocked: [], safe: [], trustedOnly: false }, req),
    ).rejects.toThrow(/active mailbox/);
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

  it("validates sender names and signatures", () => {
    expect(IdentityChange.parse({ name: ' Sam "S" <x>\n' })).toEqual({ name: "Sam S x" });
    expect(IdentityChange.parse({ signature: "Line one\r\nTwo\u0007  \n\n" })).toEqual({ signature: "Line one\nTwo" });
    expect(IdentityChange.safeParse({}).success).toBe(false);
    expect(IdentityChange.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});

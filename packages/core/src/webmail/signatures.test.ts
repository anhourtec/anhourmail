// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { SIGNATURE_HTML_MAX, WEBMAIL_SIGNATURES } from "@anhourmail/shared/signatures";

import { ACCOUNT_A, ACCOUNT_B, deps, fixedClock, req } from "../__tests__/helpers";
import type { Mailbox } from "../mailboxes/entity";
import type { Repositories } from "../ports";
import { WebmailSignaturesService } from "./signatures-service";

const MB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup() {
  const clock = fixedClock();
  const d = deps(clock);
  const mailbox = (id: string, accountId: string, address: string): Mailbox => ({
    id,
    accountId,
    userId: null,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: clock.now(),
  });
  d.uow.state.mailboxes.push(mailbox(MB_A, ACCOUNT_A, "sam@a.test"), mailbox(MB_B, ACCOUNT_B, "lee@b.test"));
  return { d, clock, svc: new WebmailSignaturesService(d) };
}

const sig = (name: string) => ({ name, html: `<p>${name} secret</p>`, text: `${name} secret` });
const idOf = (set: { signatures: { id: string; name: string }[] }, name: string) =>
  set.signatures.find((s) => s.name === name)?.id ?? "";

describe("webmail signatures service", () => {
  it("adds signatures; the first becomes both defaults and is mirrored, later ones are not", async () => {
    const { d, svc } = setup();
    expect(await svc.list("sam@a.test")).toEqual({
      signatures: [],
      defaults: { newMessage: null, reply: null },
      started: false,
    });
    const first = await svc.create("Sam@A.test", sig("Work"), req);
    const work = first.signatures[0];
    expect(work).toMatchObject({ name: "Work", html: "<p>Work secret</p>", text: "Work secret" });
    expect(first.defaults).toEqual({ newMessage: work?.id, reply: work?.id });
    expect(first.mirror).toEqual({ html: "<p>Work secret</p>", text: "Work secret" });
    const second = await svc.create("sam@a.test", sig("Home"), req);
    expect(second.signatures.map((s) => s.name).sort()).toEqual(["Home", "Work"]);
    expect(second.defaults).toEqual(first.defaults);
    expect(second.mirror).toBeUndefined();
    expect((await svc.list("sam@a.test")).started).toBe(true);

    const entry = d.uow.state.audit.at(-1);
    expect(entry).toMatchObject({
      action: "webmail.signature_added",
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      target: { type: "mailbox", id: MB_A },
      actor: { type: "system", email: "sam@a.test" },
      meta: { signatures: 2, images: 0 },
    });
    // Never a name or content in the log.
    expect(JSON.stringify(d.uow.state.audit)).not.toMatch(/secret|Home|Work/);
  });

  it("checks names, the per-mailbox count and the size cap", async () => {
    const { svc } = setup();
    await svc.create("sam@a.test", sig("Work"), req);
    await expect(svc.create("sam@a.test", sig("work"), req)).rejects.toMatchObject({ code: "conflict" });
    await expect(svc.create("sam@a.test", sig(" "), req)).rejects.toThrow(/name of up to 32/);
    await expect(svc.create("sam@a.test", sig("x".repeat(33)), req)).rejects.toThrow(/name of up to 32/);
    await expect(
      svc.create("sam@a.test", { name: "Big", html: "x".repeat(SIGNATURE_HTML_MAX + 1), text: "" }, req),
    ).rejects.toThrow(/up to 300 KB/);
    // All of a mailbox's signatures together are capped too.
    const big = (name: string) => ({ name, html: "x".repeat(SIGNATURE_HTML_MAX), text: "" });
    const bigOnes: string[] = [];
    for (const name of ["B1", "B2", "B3"]) {
      bigOnes.push((await svc.create("sam@a.test", big(name), req)).signatures.find((s) => s.name === name)?.id ?? "");
    }
    await expect(svc.create("sam@a.test", big("B4"), req)).rejects.toThrow(/together can be up to 1 MB/);
    await expect(
      svc.update("sam@a.test", bigOnes[0] ?? "", { html: "y".repeat(SIGNATURE_HTML_MAX), text: "" }, req),
    ).resolves.toBeDefined();
    for (const id of bigOnes) await svc.remove("sam@a.test", id, req);
    for (let i = 1; i < WEBMAIL_SIGNATURES.perMailbox; i++) await svc.create("sam@a.test", sig(`S${String(i)}`), req);
    await expect(svc.create("sam@a.test", sig("One more"), req)).rejects.toThrow(/up to 20 signatures/);
    // The other mailbox has none of them.
    expect((await svc.list("lee@b.test")).signatures).toEqual([]);
  });

  it("locks the mailbox's signatures before reading them, so parallel adds can't pass the caps together", async () => {
    const { d } = setup();
    const calls: string[] = [];
    // Records the order of repository calls inside each unit of work.
    const uow: typeof d.uow = Object.assign(Object.create(d.uow) as typeof d.uow, {
      run: <T>(fn: (repos: Repositories) => Promise<T>) =>
        d.uow.run((repos) => {
          const ws = repos.webmailSettings;
          const webmailSettings = {
            ...ws,
            lockSignatures: async (id: string) => {
              calls.push("lock");
              await ws.lockSignatures(id);
            },
            signatures: async (id: string) => {
              calls.push("read");
              return ws.signatures(id);
            },
          };
          return fn({ ...repos, webmailSettings });
        }),
    });
    const svc = new WebmailSignaturesService({ ...d, uow });
    await svc.create("sam@a.test", sig("Work"), req);
    // The first read inside the change comes after the lock.
    expect(calls.slice(0, 2)).toEqual(["lock", "read"]);

    const results = await Promise.allSettled(
      Array.from({ length: WEBMAIL_SIGNATURES.perMailbox + 5 }, (_, i) =>
        svc.create("sam@a.test", sig(`P${String(i)}`), req),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(WEBMAIL_SIGNATURES.perMailbox - 1);
    expect((await svc.list("sam@a.test")).signatures).toHaveLength(WEBMAIL_SIGNATURES.perMailbox);
  });

  it("renames and rewrites; mirrors only when the default for new messages changed", async () => {
    const { svc } = setup();
    const a = idOf(await svc.create("sam@a.test", sig("Work"), req), "Work");
    const b = idOf(await svc.create("sam@a.test", sig("Home"), req), "Home");
    const renamed = await svc.update("sam@a.test", a, { name: "Office" }, req);
    expect(idOf(renamed, "Office")).toBe(a);
    expect(renamed.mirror).toBeUndefined();
    const rewritten = await svc.update("sam@a.test", a, { html: "<p>New</p>", text: "New" }, req);
    expect(rewritten.mirror).toEqual({ html: "<p>New</p>", text: "New" });
    expect((await svc.update("sam@a.test", b, { html: "<p>H</p>", text: "H" }, req)).mirror).toBeUndefined();
    await expect(svc.update("sam@a.test", b, { name: "office" }, req)).rejects.toMatchObject({ code: "conflict" });
    await expect(svc.update("sam@a.test", a, {}, req)).rejects.toThrow(/Nothing to change/);
  });

  it("sets defaults (none allowed) and a deleted default falls back to none", async () => {
    const { svc } = setup();
    const a = idOf(await svc.create("sam@a.test", sig("Work"), req), "Work");
    const b = idOf(await svc.create("sam@a.test", sig("Home"), req), "Home");
    const set = await svc.setDefaults("sam@a.test", { newMessage: b, reply: a }, req);
    expect(set.defaults).toEqual({ newMessage: b, reply: a });
    expect(set.mirror).toEqual({ html: "<p>Home secret</p>", text: "Home secret" });
    const none = await svc.setDefaults("sam@a.test", { newMessage: null, reply: a }, req);
    expect(none.mirror).toBeNull();
    await svc.setDefaults("sam@a.test", { newMessage: b, reply: b }, req);
    const removed = await svc.remove("sam@a.test", b, req);
    expect(removed.signatures.map((s) => s.id)).toEqual([a]);
    expect(removed.defaults).toEqual({ newMessage: null, reply: null });
    expect(removed.mirror).toBeNull();
  });

  it("treats another mailbox's signatures and malformed ids as not found", async () => {
    const { d, svc } = setup();
    const lee = (await svc.create("lee@b.test", sig("Lee"), req)).signatures[0]?.id ?? "";
    await svc.create("sam@a.test", sig("Sam"), req);
    await expect(svc.update("sam@a.test", lee, { name: "Mine" }, req)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.remove("sam@a.test", lee, req)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.setDefaults("sam@a.test", { newMessage: lee, reply: null }, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(svc.remove("sam@a.test", "not-an-id", req)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.list("nobody@a.test")).rejects.toMatchObject({ code: "not_found" });
    expect((await svc.list("lee@b.test")).signatures[0]?.name).toBe("Lee");
    // The refusals were audited in Sam's log as failures, without the other mailbox's content.
    const failed = d.uow.state.audit.filter((e) => e.result === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain("Lee secret");
  });

  it("brings the old signature over once, never after signatures were started", async () => {
    const { d, svc } = setup();
    const old = { html: "<div>Sam</div>", text: "Sam" };
    expect(await svc.bringOver("sam@a.test", { html: "", text: "  " }, req)).toBeNull();
    const made = await svc.bringOver("sam@a.test", old, req);
    expect(made?.signatures).toEqual([{ id: made?.defaults.newMessage, name: "Signature", ...old }]);
    expect(made?.defaults.reply).toBe(made?.defaults.newMessage);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "webmail.signature_added",
      meta: { broughtOver: true, madeDefault: true },
    });
    expect(await svc.bringOver("sam@a.test", old, req)).toBeNull();
    // Deleting every signature doesn't bring it back.
    await svc.remove("sam@a.test", made?.defaults.newMessage ?? "", req);
    expect(await svc.bringOver("sam@a.test", old, req)).toBeNull();
    // A mailbox that started by adding one never gets the old one.
    await svc.create("lee@b.test", sig("Lee"), req);
    expect(await svc.bringOver("lee@b.test", old, req)).toBeNull();
  });
});

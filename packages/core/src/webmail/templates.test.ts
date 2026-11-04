// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { TEMPLATE_HTML_MAX, WEBMAIL_TEMPLATES } from "@anhourmail/shared/templates";

import { ACCOUNT_A, ACCOUNT_B, deps, fixedClock, req } from "../__tests__/helpers";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { WebmailTemplatesService } from "./templates-service";

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
  return { d, svc: new WebmailTemplatesService(d) };
}

const tpl = (name: string) => ({ name, html: `<p>${name} private words</p>`, text: `${name} private words` });

describe("webmail templates service", () => {
  it("adds, renames, rewrites and deletes templates, audited with ids and sizes only", async () => {
    const { d, svc } = setup();
    expect(await svc.list("sam@a.test")).toEqual([]);
    const added = await svc.create("Sam@A.test", tpl("Thanks"), req);
    const id = added[0]?.id ?? "";
    await svc.create("sam@a.test", tpl("Away"), req);
    expect((await svc.list("sam@a.test")).map((t) => t.name)).toEqual(["Away", "Thanks"]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "webmail.template_added",
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      target: { type: "mailbox", id: MB_A },
      meta: { templates: 2 },
    });
    const renamed = await svc.update("sam@a.test", id, { name: " Thank you " }, req);
    expect(renamed.find((t) => t.id === id)?.name).toBe("Thank you");
    const rewritten = await svc.update("sam@a.test", id, { html: "<p>New</p>", text: "New" }, req);
    expect(rewritten.find((t) => t.id === id)).toMatchObject({ html: "<p>New</p>", text: "New" });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "webmail.template_changed", meta: { bytes: 10 } });
    expect(await svc.remove("sam@a.test", id, req)).toHaveLength(1);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "webmail.template_removed", meta: { templates: 1 } });
    expect(JSON.stringify(d.uow.state.audit)).not.toMatch(/private|Thanks|Thank you|Away/);
  });

  it("checks names, content, the per-mailbox count and the size cap", async () => {
    const { svc } = setup();
    await expect(svc.create("sam@a.test", { ...tpl("x"), name: "" }, req)).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.create("sam@a.test", { ...tpl("x"), name: "x".repeat(65) }, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(svc.create("sam@a.test", { name: "Empty", html: " ", text: "" }, req)).rejects.toThrow(/text/);
    await expect(
      svc.create("sam@a.test", { name: "Big", html: "x".repeat(TEMPLATE_HTML_MAX + 1), text: "x" }, req),
    ).rejects.toThrow(/64 KB/);
    await svc.create("sam@a.test", tpl("One"), req);
    await expect(svc.create("sam@a.test", tpl("ONE"), req)).rejects.toBeInstanceOf(ConflictError);
    for (let i = 1; i < WEBMAIL_TEMPLATES.perMailbox; i++) await svc.create("sam@a.test", tpl(`T${String(i)}`), req);
    await expect(svc.create("sam@a.test", tpl("Too many"), req)).rejects.toThrow(/up to 50/);
    await expect(svc.update("sam@a.test", MB_A, {}, req)).rejects.toBeInstanceOf(ValidationError);
  });

  it("treats another mailbox's template as not found, and an unknown mailbox too", async () => {
    const { svc } = setup();
    const theirs = (await svc.create("lee@b.test", tpl("Theirs"), req))[0]?.id ?? "";
    await expect(svc.update("sam@a.test", theirs, { name: "Mine" }, req)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.remove("sam@a.test", theirs, req)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.remove("sam@a.test", "not-a-uuid", req)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.list("nobody@x.test")).rejects.toBeInstanceOf(NotFoundError);
    expect(await svc.list("lee@b.test")).toHaveLength(1);
  });
});

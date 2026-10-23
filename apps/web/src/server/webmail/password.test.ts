// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PasswordJobState } from "@anhourmail/core/mailboxes";
import { BreachedPasswordError } from "@anhourmail/core/security";
import { setLogSinkForTests } from "@anhourmail/server/log";

import { changeWebmailPassword, type PasswordChangeDeps } from "./password";
import { WebmailRefusedError, WebmailSignedOutError, WebmailSignInError, WebmailUnavailableError } from "./service";
import type { WebmailSession } from "./session-store";

const meta = { requestId: "r", ip: null, userAgent: null };
const CURRENT = "the old password here";
const NEXT = "a brand new password";

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

function setup(opts: { states?: PasswordJobState[]; signedOut?: boolean; renew?: () => Promise<string> } = {}) {
  const log: string[] = [];
  const failures = new Map<string, number>();
  const states = [...(opts.states ?? ["pending", "applied"])];
  const d: PasswordChangeDeps = {
    mail: {
      session: async () =>
        opts.signedOut
          ? null
          : ({ username: "kid@family.ca", accountId: "acc1", createdAt: 0 } as unknown as WebmailSession),
      checkPassword: async (address, password) => {
        log.push(`check ${address}`);
        if (password !== CURRENT) throw new WebmailSignInError("refused");
      },
      renewMailbox:
        opts.renew ??
        (async (_id, address) => {
          log.push(`renew ${address}`);
          return "new-session-id";
        }),
    },
    change: async (address) => {
      log.push(`change ${address}`);
      return { jobId: "job-1", ownerEmail: "kid@console.test" };
    },
    notify: async (to, address) => void log.push(`notify ${to} ${address}`),
    state: async () => states.shift() ?? states.at(-1) ?? "pending",
    failures: {
      exceeded: async (address) => (failures.get(address) ?? 0) >= 2,
      record: async (address) => void failures.set(address, (failures.get(address) ?? 0) + 1),
    },
    sleep: async () => undefined,
  };
  return { d, log, failures };
}

describe("changing the webmail password", () => {
  it("checks the current password, queues the change, waits for it and keeps this session signed in", async () => {
    const t = setup();
    expect(await changeWebmailPassword(t.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta)).toEqual({
      applied: true,
      signedIn: true,
      sessionId: "new-session-id",
    });
    expect(t.log).toEqual([
      "check kid@family.ca",
      "change kid@family.ca",
      "notify kid@console.test kid@family.ca",
      "renew kid@family.ca",
    ]);
  });

  it("refuses when the page shows another mailbox than the session's (a switch in another tab)", async () => {
    const t = setup();
    for (const account of ["acc2", null]) {
      await expect(changeWebmailPassword(t.d, "sid", { current: CURRENT, next: NEXT, account }, meta)).rejects.toThrow(
        "Reload the page and try again.",
      );
    }
    expect(t.log).toEqual([]);
  });

  it("refuses a wrong current password (counted per address, then locked) without changing anything", async () => {
    const t = setup();
    for (let i = 0; i < 2; i++) {
      await expect(
        changeWebmailPassword(t.d, "sid", { current: "nope nope nope", next: NEXT, account: "acc1" }, meta),
      ).rejects.toThrow("Your current password isn't right.");
    }
    await expect(
      changeWebmailPassword(t.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta),
    ).rejects.toThrow(/Too many wrong passwords/);
    expect(t.log.filter((l) => l.startsWith("change"))).toEqual([]);
  });

  it("refuses a weak or unchanged new password before asking the mail server", async () => {
    const t = setup();
    for (const next of ["short", "kid@family.ca", " padded password ", CURRENT]) {
      await expect(
        changeWebmailPassword(t.d, "sid", { current: CURRENT, next, account: "acc1" }, meta),
      ).rejects.toBeInstanceOf(WebmailRefusedError);
    }
    expect(t.log).toEqual([]);
  });

  it("a breached new password is refused after the current one checks out; nothing is applied or announced", async () => {
    const t = setup();
    t.d.change = async () => {
      t.log.push("change refused");
      throw new BreachedPasswordError();
    };
    await expect(
      changeWebmailPassword(t.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta),
    ).rejects.toMatchObject({ code: "password_breached" });
    expect(t.log).toEqual(["check kid@family.ca", "change refused"]);
  });

  it("says when the change is still applying, and when it failed (the old password still works)", async () => {
    const slow = setup({ states: ["pending"] });
    slow.d.waitMs = 0;
    expect(await changeWebmailPassword(slow.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta)).toEqual(
      {
        applied: false,
        signedIn: false,
      },
    );
    const failed = setup({ states: ["pending", "failed"] });
    await expect(
      changeWebmailPassword(failed.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta),
    ).rejects.toThrow(/current password still works/);
  });

  it("reports a change whose session couldn't be renewed, and refuses a signed-out session", async () => {
    const t = setup({ renew: () => Promise.reject(new WebmailUnavailableError("down")) });
    expect(await changeWebmailPassword(t.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta)).toEqual({
      applied: true,
      signedIn: false,
    });
    const out = setup({ signedOut: true });
    await expect(
      changeWebmailPassword(out.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta),
    ).rejects.toBeInstanceOf(WebmailSignedOutError);
  });

  it("passes other mail-server trouble through", async () => {
    const t = setup();
    t.d.mail.checkPassword = () => Promise.reject(new WebmailUnavailableError("down"));
    await expect(
      changeWebmailPassword(t.d, "sid", { current: CURRENT, next: NEXT, account: "acc1" }, meta),
    ).rejects.toBeInstanceOf(WebmailUnavailableError);
  });
});

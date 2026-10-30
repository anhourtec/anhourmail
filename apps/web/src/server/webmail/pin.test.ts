// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";

import {
  navigationFromUs,
  ownPinFrom,
  PinnedMailboxMissingError,
  pinFrom,
  pinnedAddress,
  pinnedKind,
  pinView,
  requestPin,
  unpinWrite,
  withPinnedMailbox,
} from "./pin";
import { memoryKv, type MailboxTokens, type WebmailSession, WebmailSessionStore } from "./session-store";

const entry = (username: string, delegated: false | "full_access" | "send" = false): MailboxTokens => ({
  username,
  accountId: `acc-${username}`,
  accessToken: `at-${username}`,
  refreshToken: `rt-${username}`,
  expiresAt: 9e12,
  ...(delegated
    ? {
        delegated: { mailboxId: `id-${username}`, granteeUserId: "kim", via: "kim@family.test", opened: delegated },
      }
    : {}),
});

/** Kim's own mailbox active, then her second own one and two mailboxes shared with her. */
const session = (): WebmailSession => ({
  ...entry("kim@family.test"),
  createdAt: 1,
  version: 4,
  console: { userId: "kim", sessionId: "c1" },
  others: [
    entry("kim@other.test"),
    entry("desk@family.test", "full_access"),
    entry("team@family.test", "full_access"),
    entry("sales@family.test", "send"),
  ],
});

const req = (headers: Record<string, string> = {}, query = "") =>
  new Request(`http://mail.test/api/webmail/jmap${query}`, { headers });

describe("pinning a shared mailbox to one tab (ADR-0026 §6, Open another mailbox)", () => {
  it("reads the pin from the header, then the query, lowercased; none is null", () => {
    expect(pinFrom(req({ "x-webmail-shared": " Desk@Family.test " }))).toBe("desk@family.test");
    expect(pinFrom(req({}, "?shared=desk%40family.test&download=1"))).toBe("desk@family.test");
    expect(pinFrom(req({ "x-webmail-shared": "desk@family.test" }, "?shared=team%40family.test"))).toBe(
      "desk@family.test",
    );
    expect(pinFrom(req())).toBeNull();
  });

  it("refuses a pin that isn't an address rather than ignoring it", () => {
    for (const bad of ["", "desk", "a@b@c", "<desk@family.test>", "desk@family.test|x", `${"a".repeat(250)}@b.test`]) {
      expect(() => pinFrom(req({ "x-webmail-shared": bad }))).toThrow(PinnedMailboxMissingError);
    }
  });

  it("shows the pinned shared mailbox as the active one, every other position kept", () => {
    const s = session();
    const view = withPinnedMailbox("desk@family.test", () => pinView(s));
    expect(view.username).toBe("desk@family.test");
    expect(view.delegated?.mailboxId).toBe("id-desk@family.test");
    expect(view.others?.map((m) => m.username)).toEqual([
      "kim@other.test",
      "kim@family.test",
      "team@family.test",
      "sales@family.test",
    ]);
    expect(view.others?.[1]?.delegated).toBeUndefined();
    expect(view).toMatchObject({ createdAt: 1, version: 4, console: { userId: "kim", sessionId: "c1" } });
  });

  it("writes back with the session's real active mailbox, so other tabs keep theirs", () => {
    const s = session();
    withPinnedMailbox("desk@family.test", () => {
      const view = pinView(s);
      const refreshed = { ...view, accessToken: "at-desk-r1" };
      const written = unpinWrite(refreshed, s);
      expect(written.username).toBe("kim@family.test");
      expect(written.others?.map((m) => m.username)).toEqual([
        "kim@other.test",
        "desk@family.test",
        "team@family.test",
        "sales@family.test",
      ]);
      expect(written.others?.[1]?.accessToken).toBe("at-desk-r1");
    });
  });

  it("changes nothing without a pin, or when the pinned mailbox is the active one already", () => {
    const s = session();
    expect(pinView(s)).toBe(s);
    expect(unpinWrite(s, s)).toBe(s);
    expect(pinnedAddress()).toBeNull();
    const active = { ...entry("desk@family.test", "full_access"), createdAt: 1, others: [entry("kim@family.test")] };
    withPinnedMailbox("desk@family.test", () => {
      expect(pinnedAddress()).toBe("desk@family.test");
      expect(pinView(active)).toBe(active);
      expect(unpinWrite(active, active)).toBe(active);
      // A null pin inside a pinned request runs unpinned.
      expect(withPinnedMailbox(null, () => pinnedAddress())).toBeNull();
    });
  });

  it("refuses a pin on the person's own mailboxes, one not open, and one opened by a send (send right only)", () => {
    const s = session();
    for (const address of ["kim@family.test", "kim@other.test", "lee@family.test", "sales@family.test"]) {
      expect(() => withPinnedMailbox(address, () => pinView(s))).toThrow(PinnedMailboxMissingError);
    }
  });

  it("hands a gone real active entry over to the mailbox it came through, never to the pinned one", () => {
    // The real active entry was a shared one (lee@, through kim@other.test) that went while desk@ was pinned.
    const stored: WebmailSession = {
      ...entry("lee@family.test", "full_access"),
      delegated: { mailboxId: "id-lee", granteeUserId: "kim", via: "kim@other.test", opened: "full_access" },
      createdAt: 1,
      others: [entry("kim@family.test"), entry("kim@other.test"), entry("desk@family.test", "full_access")],
    };
    withPinnedMailbox("desk@family.test", () => {
      const view = pinView(stored);
      const { others = [], ...top } = view;
      const dropped: WebmailSession = { ...top, others: others.filter((m) => m.username !== "lee@family.test") };
      const written = unpinWrite(dropped, stored);
      expect(written.username).toBe("kim@other.test");
      // Without that one, the first of the person's own.
      const noVia: WebmailSession = { ...top, others: [entry("kim@family.test")] };
      expect(unpinWrite(noVia, stored).username).toBe("kim@family.test");
      // Nothing to hand to: refused rather than leaving the pinned entry active for every tab.
      expect(() => unpinWrite({ ...top, others: [] }, stored)).toThrow(PinnedMailboxMissingError);
    });
  });

  it("opens an address-scoped page by itself only for navigations from us, never from another site", () => {
    for (const site of ["same-origin", "same-site", "none"]) expect(navigationFromUs(site)).toBe(true);
    // A link on another site (or a browser that sends no Fetch Metadata): the page asks for a click first.
    for (const site of ["cross-site", null, ""]) expect(navigationFromUs(site)).toBe(false);
  });

  it("honours a pin in a link only from this origin", () => {
    const at = (site: string) => req({ "sec-fetch-site": site }, "?shared=desk%40family.test");
    expect(pinFrom(at("same-origin"))).toBe("desk@family.test");
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(() => pinFrom(at(site))).toThrow(PinnedMailboxMissingError);
    }
    // The header is set by the tab's own script (a cross-site page can't send it without a preflight).
    expect(pinFrom(req({ "x-webmail-shared": "desk@family.test", "sec-fetch-site": "same-origin" }))).toBe(
      "desk@family.test",
    );
  });

  it("goes through the session store: a pinned read and write leave the stored active mailbox alone", async () => {
    const store = new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "k1", key: randomBytes(32) }]));
    const id = await store.create({ ...session(), createdAt: Date.now() });
    await withPinnedMailbox("team@family.test", async () => {
      const view = await store.read(id);
      expect(view?.username).toBe("team@family.test");
      if (!view) throw new Error("no session");
      expect(await store.write(id, { ...view, accessToken: "at-team-r1" })).toBe(true);
      expect((await store.read(id))?.accessToken).toBe("at-team-r1");
    });
    const stored = await store.read(id);
    expect(stored?.username).toBe("kim@family.test");
    expect(stored?.others?.find((m) => m.username === "team@family.test")?.accessToken).toBe("at-team-r1");
    await expect(withPinnedMailbox("lee@family.test", () => store.read(id))).rejects.toThrow(PinnedMailboxMissingError);
  });
});

describe("pinning the person's own mailbox for a shared tab's compose requests (ADR-0026 §6, sending from one)", () => {
  it("reads the own pin from its header only, lowercased; never from a link; malformed or both kinds refused", () => {
    expect(ownPinFrom(req({ "x-webmail-own": " Kim@Family.test " }))).toBe("kim@family.test");
    expect(ownPinFrom(req({}, "?own=kim%40family.test"))).toBeNull();
    expect(requestPin(req({ "x-webmail-own": "kim@family.test" }))).toEqual({
      address: "kim@family.test",
      kind: "own",
    });
    expect(requestPin(req({ "x-webmail-shared": "desk@family.test" }))).toEqual({
      address: "desk@family.test",
      kind: "shared",
    });
    expect(requestPin(req())).toBeNull();
    for (const bad of ["", "kim", "<kim@family.test>", "kim@family.test|x"]) {
      expect(() => requestPin(req({ "x-webmail-own": bad }))).toThrow(PinnedMailboxMissingError);
    }
    expect(() =>
      requestPin(req({ "x-webmail-own": "kim@family.test", "x-webmail-shared": "desk@family.test" })),
    ).toThrow(PinnedMailboxMissingError);
    expect(() =>
      requestPin(
        req({ "x-webmail-own": "kim@family.test", "sec-fetch-site": "same-origin" }, "?shared=desk%40family.test"),
      ),
    ).toThrow(PinnedMailboxMissingError);
  });

  it("shows one of the person's own sign-ins as the active one, and writes the real active one back", () => {
    // The session's real active mailbox is a shared one (switched to in another tab).
    const stored: WebmailSession = {
      ...entry("desk@family.test", "full_access"),
      createdAt: 1,
      version: 2,
      others: [entry("kim@family.test"), entry("kim@other.test"), entry("team@family.test", "full_access")],
    };
    withPinnedMailbox(
      "kim@family.test",
      () => {
        expect(pinnedKind()).toBe("own");
        const view = pinView(stored);
        expect(view.username).toBe("kim@family.test");
        expect(view.delegated).toBeUndefined();
        const written = unpinWrite({ ...view, accessToken: "at-kim-r1" }, stored);
        expect(written.username).toBe("desk@family.test");
        expect(written.others?.find((m) => m.username === "kim@family.test")?.accessToken).toBe("at-kim-r1");
      },
      "own",
    );
    // Already the active one: unchanged.
    const s = session();
    withPinnedMailbox(
      "kim@family.test",
      () => {
        expect(pinView(s)).toBe(s);
      },
      "own",
    );
  });

  it("never makes a delegated entry, or a mailbox not signed in here, active through an own pin", () => {
    const s = session();
    for (const address of ["desk@family.test", "team@family.test", "sales@family.test", "lee@family.test"]) {
      expect(() => withPinnedMailbox(address, () => pinView(s), "own")).toThrow(PinnedMailboxMissingError);
    }
  });

  it("goes through the session store: compose requests see the own mailbox, the stored active one stays", async () => {
    const store = new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "k1", key: randomBytes(32) }]));
    const s = session();
    const { others = [], ...kim } = s;
    const desk = others[1];
    if (!desk) throw new Error("fixture");
    // desk@ (shared) is the session's active mailbox; kim@ is one of the others.
    const id = await store.create({
      ...desk,
      createdAt: Date.now(),
      others: [kim, ...others.filter((m) => m !== desk)],
    });
    await withPinnedMailbox(
      "kim@family.test",
      async () => {
        const view = await store.read(id);
        expect(view?.username).toBe("kim@family.test");
        if (!view) throw new Error("no session");
        expect(await store.write(id, { ...view, accessToken: "at-kim-r2" })).toBe(true);
      },
      "own",
    );
    const after = await store.read(id);
    expect(after?.username).toBe("desk@family.test");
    expect(after?.others?.find((m) => m.username === "kim@family.test")?.accessToken).toBe("at-kim-r2");
  });
});

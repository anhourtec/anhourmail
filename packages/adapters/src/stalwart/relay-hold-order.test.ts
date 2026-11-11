// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The order `ensureMailbox` applies the relay hold in (ADR-0034 update "relay hold"), against fakes of the provisioning
 * and hold keys' clients: a held mailbox is unable to send at all until it is listed, the list reloaded and the
 * relaying policy checked; every failure on the way leaves it so. Pinned against the real server in
 * `trust-access.int.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { EnsureIncompleteError } from "@anhourmail/core/provisioning";

import {
  accessOf,
  desiredRelaying,
  type MailboxAccess,
  RELAY_HOLD_NAMESPACE,
  SEND_BLOCKED_PERMISSIONS,
  SMTP_BLOCKED_PERMISSIONS,
  StalwartError,
  type StalwartManagement,
  SUSPENDED_PERMISSIONS,
} from "@anhourmail/stalwart-client";

import { stalwartMailServer } from ".";

const ADDRESS = "held@example.test";
const PERMS: Record<MailboxAccess, { disabledPermissions?: Record<string, boolean> } | undefined> = {
  active: undefined,
  smtp_blocked: SMTP_BLOCKED_PERMISSIONS,
  send_blocked: SEND_BLOCKED_PERMISSIONS,
  receive_blocked: undefined,
  suspended: SUSPENDED_PERMISSIONS,
};

type Opts = {
  /** The account already exists with this access. */
  existing?: MailboxAccess;
  listed?: boolean;
  policy?: unknown;
  failAdd?: boolean;
  failReload?: boolean;
  /** Writing this access fails. */
  failWrite?: MailboxAccess;
  /** Reading the account fails. */
  failRead?: boolean;
};

/** Fakes of both clients that record what happens, in order. */
function fakes(opts: Opts = {}) {
  const log: string[] = [];
  const state = {
    access: opts.existing ?? null,
    keys: new Set<string>(opts.listed ? [ADDRESS] : []),
    loaded: new Set<string>(opts.listed ? [ADDRESS] : []),
  };
  const mgmt = {
    listUsers: async () => (state.access ? [{ id: "acc-1", address: ADDRESS }] : []),
    upsertUser: async (input: { access?: MailboxAccess; suspended?: boolean }) => {
      const access = input.suspended === true ? "suspended" : (input.access ?? "active");
      if (opts.failWrite === access) throw new StalwartError("x:Account/set notUpdated", "set", {});
      log.push(`write ${access}`);
      state.access = access;
      return "acc-1";
    },
    passwordCredentialId: async () => "pw-1",
    transport: {
      getAll: async (object: string) => {
        if (object !== "x:Account") throw new Error(`unexpected ${object}`);
        if (opts.failRead) throw new TypeError("fetch failed");
        return state.access ? [{ id: "acc-1", permissions: PERMS[state.access] }] : [];
      },
    },
  } as unknown as StalwartManagement;
  const hold = {
    transport: {
      set: async (
        object: string,
        args: { create?: Record<string, { key?: string; "@type"?: string }>; destroy?: string[] },
      ) => {
        if (object === "x:Action") {
          log.push("reload");
          if (opts.failReload) throw new StalwartError("x:Action/set notCreated", "set", { a: { type: "forbidden" } });
          state.loaded = new Set(state.keys);
          return { created: { a: { id: "x" } } };
        }
        const create = Object.values(args.create ?? {})[0];
        if (create?.key) {
          if (opts.failAdd)
            throw new StalwartError("x:MemoryLookupKey/set notCreated", "set", { k: { type: "forbidden" } });
          if (state.keys.has(create.key)) {
            throw new StalwartError("x:MemoryLookupKey/set notCreated", "set", {
              k: { type: "primaryKeyViolation", objectId: { id: `id-${create.key}` } },
            });
          }
          log.push(`list ${create.key}`);
          state.keys.add(create.key);
          return { created: { k: { id: `id-${create.key}` } } };
        }
        for (const id of args.destroy ?? []) {
          const key = id.replace(/^id-/, "");
          log.push(`unlist ${key}`);
          state.keys.delete(key);
        }
        return { created: {} };
      },
      getAll: async (object: string) => {
        if (object !== "x:MtaStageRcpt") throw new Error(`unexpected ${object}`);
        return [{ id: "singleton", allowRelaying: opts.policy === undefined ? desiredRelaying() : opts.policy }];
      },
    },
  } as unknown as StalwartManagement;
  return { mgmt, hold, log, state };
}

const input = (access: "active" | "smtp_blocked" | "send_blocked", relayHold: boolean, externalId: string | null) => ({
  externalId,
  initialPasswordHash: null,
  address: ADDRESS,
  quotaBytes: 1000,
  suspended: false,
  access,
  relayHold,
  aliases: [],
});

/** Whether the account could send to an outside address at this moment (SMTP or JMAP). */
const canRelay = (f: ReturnType<typeof fakes>) =>
  f.state.access !== null &&
  !f.state.loaded.has(ADDRESS) &&
  (accessOf(PERMS[f.state.access]) === "active" || accessOf(PERMS[f.state.access]) === "smtp_blocked");

describe("ensureMailbox and the relay hold (fail closed)", () => {
  it("creates a new held mailbox only once it is listed, the list reloaded and the policy checked", async () => {
    const f = fakes();
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("smtp_blocked", true, null));
    expect(f.log).toEqual([`list ${ADDRESS}`, "reload", "write smtp_blocked"]);
    expect(f.state.loaded.has(ADDRESS)).toBe(true);
    // A failed reload or a missing policy leaves nothing on the mail server: the retry starts clean.
    for (const opts of [{ failReload: true }, { policy: null }, { failAdd: true }]) {
      const g = fakes(opts);
      await expect(
        stalwartMailServer(g.mgmt, { hold: g.hold }).ensureMailbox(input("smtp_blocked", true, null)),
      ).rejects.toThrow();
      expect(g.state.access).toBeNull();
    }
  });

  it("tightens an account that could send before listing it (a tier taken back)", async () => {
    const f = fakes({ existing: "active" });
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("smtp_blocked", true, "acc-1"));
    expect(f.log).toEqual([`list ${ADDRESS}`, "write send_blocked", "reload", "write smtp_blocked"]);
  });

  it("reloads and writes the access when the mailbox is already held as it should be (no tightening)", async () => {
    const f = fakes({ existing: "smtp_blocked", listed: true });
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("smtp_blocked", true, "acc-1"));
    expect(f.log).toEqual(["reload", "write smtp_blocked"]);
  });

  it("loads a key that was stored but never loaded, even when the access is already what it should be", async () => {
    // A restricted mailbox: its earlier attempt listed it and its reload failed; it was already send-blocked.
    const f = fakes({ existing: "send_blocked", listed: true });
    f.state.loaded.clear();
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("send_blocked", true, "acc-1"));
    expect(f.log).toEqual(["reload", "write send_blocked"]);
    expect(f.state.loaded.has(ADDRESS)).toBe(true);
  });

  it("leaves the mailbox unable to send when listing, the reload or the policy fails; a retry finishes it", async () => {
    for (const opts of [
      { failAdd: true },
      { failReload: true },
      { policy: { match: {}, else: "!is_empty(authenticated_as)" } },
    ]) {
      const f = fakes({ existing: "active", ...opts });
      await expect(
        stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("smtp_blocked", true, "acc-1")),
      ).rejects.toThrow();
      expect(f.state.access).toBe("send_blocked");
      expect(canRelay(f)).toBe(false);
    }
    // The reload failed after listing: the retry finds it listed but not yet given its access, so it reloads again.
    const f = fakes({ existing: "send_blocked", listed: true });
    f.state.loaded.clear();
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("smtp_blocked", true, "acc-1"));
    expect(f.log).toEqual(["reload", "write smtp_blocked"]);
    expect(f.state.loaded.has(ADDRESS)).toBe(true);
  });

  it("refuses a held mailbox without the hold credential, and changes nothing", async () => {
    const f = fakes({ existing: "active" });
    await expect(stalwartMailServer(f.mgmt).ensureMailbox(input("smtp_blocked", true, "acc-1"))).rejects.toThrow(
      /relay hold credential/,
    );
    expect(f.log).toEqual([]);
  });

  it("unlists and reloads before opening a promoted mailbox; a retry after a failed reload reloads again", async () => {
    const f = fakes({ existing: "smtp_blocked", listed: true });
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("active", false, "acc-1"));
    expect(f.log).toEqual([`unlist ${ADDRESS}`, "reload", "write active"]);
    const g = fakes({ existing: "smtp_blocked", listed: true, failReload: true });
    await expect(
      stalwartMailServer(g.mgmt, { hold: g.hold }).ensureMailbox(input("active", false, "acc-1")),
    ).rejects.toThrow();
    // Still held on the server (the key stays loaded until a reload), and the access not yet opened.
    expect(g.state.loaded.has(ADDRESS)).toBe(true);
    expect(g.state.access).toBe("smtp_blocked");
    const h = fakes({ existing: "smtp_blocked" });
    h.state.loaded.add(ADDRESS);
    await stalwartMailServer(h.mgmt, { hold: h.hold }).ensureMailbox(input("active", false, "acc-1"));
    // The lookup writes and destroys the key, then reloads: that is also the reload the failed attempt owed.
    expect(h.log).toEqual([`list ${ADDRESS}`, `unlist ${ADDRESS}`, "reload", "write active"]);
    expect(h.state.loaded.has(ADDRESS)).toBe(false);
  });

  it("reloads after looking up a mailbox that was never held, so its lookup key is never left loaded", async () => {
    const f = fakes({ existing: "active" });
    await stalwartMailServer(f.mgmt, { hold: f.hold }).ensureMailbox(input("active", false, "acc-1"));
    expect(f.log).toEqual([`list ${ADDRESS}`, `unlist ${ADDRESS}`, "reload", "write active"]);
    expect(f.state.loaded.has(ADDRESS)).toBe(false);
  });

  it("says whether a failure left the account looser than wanted (core never gives up on those)", async () => {
    const failure = async (
      f: ReturnType<typeof fakes>,
      args: Parameters<ReturnType<typeof stalwartMailServer>["ensureMailbox"]>[0],
    ) => {
      const err: unknown = await stalwartMailServer(f.mgmt, { hold: f.hold })
        .ensureMailbox(args)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(EnsureIncompleteError);
      return (err as EnsureIncompleteError).looserThanWanted;
    };
    // A new mailbox whose reload failed: nothing was created, so nothing is open.
    expect(await failure(fakes({ failReload: true }), input("smtp_blocked", true, null))).toBe(false);
    // Couldn't list it, but it was made unable to send first: at least as strict as wanted.
    expect(await failure(fakes({ existing: "active", failAdd: true }), input("smtp_blocked", true, "acc-1"))).toBe(
      false,
    );
    // Listed and already send-blocked when the reload failed: can't send at all.
    expect(await failure(fakes({ existing: "active", failReload: true }), input("smtp_blocked", true, "acc-1"))).toBe(
      false,
    );
    // Already at its access but the reload (the one that would load its key) failed: may still relay.
    expect(
      await failure(
        fakes({ existing: "smtp_blocked", listed: true, failReload: true }),
        input("smtp_blocked", true, "acc-1"),
      ),
    ).toBe(true);
    // A suspension whose write failed: still open.
    expect(
      await failure(fakes({ existing: "active", failWrite: "suspended" }), {
        ...input("send_blocked", false, "acc-1"),
        suspended: true,
      }),
    ).toBe(true);
    // A promotion whose write failed: still stricter than wanted.
    expect(
      await failure(fakes({ existing: "smtp_blocked", failWrite: "active" }), input("active", false, "acc-1")),
    ).toBe(false);
    // The account couldn't be read at all: unknown.
    expect(
      await failure(fakes({ existing: "active", failRead: true }), input("send_blocked", false, "acc-1")),
    ).toBeNull();
  });

  it("never names another namespace", () => {
    expect(RELAY_HOLD_NAMESPACE).toBe("anhourmail-relay-hold");
  });
});

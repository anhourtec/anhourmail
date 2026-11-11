// SPDX-License-Identifier: MIT
/**
 * The relay hold: accounts that may send only to addresses the server hosts (research/stalwart.md "Relay hold",
 * verified on the pinned v0.16.27, 2026-11-11). A held account is one key in an `x:MemoryLookupKey` namespace, and
 * `x:MtaStageRcpt.allowRelaying` starts with a branch that refuses relaying for it:
 *
 *   if key_exists('<namespace>', authenticated_as) then false   (else: the default, any authenticated session)
 *
 * Relaying is only ever asked about for a recipient on a domain the server doesn't host, so local delivery is
 * untouched. It covers every authenticated path (SMTP submission and JMAP `EmailSubmission`, with a password or any
 * app password): an outside recipient gets `550 5.1.2 Relay not allowed.` at RCPT, or in the submission's
 * `deliveryStatus` over JMAP. `authenticated_as` is the account's own name however the person signed in (an alias, upper
 * case), and an expression that fails to evaluate refuses relaying.
 *
 * What the server does with the list (pinned in `relay-hold.int.test.ts`):
 *
 * - A key written through management is in force only after `x:Action` `ReloadLookupStores`; a destroyed key keeps
 *   holding until then. So adding fails open until the reload and removing fails safe: callers reload before they
 *   relax anything else that stops the account sending (`RelayHoldList.reload`).
 * - `ReloadSettings` neither loads nor drops keys. Keys are stored in the data store, survive a restart and are all in
 *   force at start, a key never reloaded included.
 * - A reload with 3,000 keys took 2 ms; writing them took 0.3 s in batches of 500.
 * - Every refused recipient counts towards Stalwart's abuse ban of the client's address **and** of the recipient
 *   address (`x:Security.abuseBanRate`, default 35 a UTC day, ban permanent): a held account's mail app that keeps
 *   trying outside recipients gets its address banned from every protocol. That is why a `new` account's mail apps stay
 *   refused at SMTP AUTH (which doesn't count) and the hold covers JMAP (ADR-0034 update "relay hold").
 *
 * Keys are the account's address in lower case. The namespace's permission covers every namespace, the spam filter's
 * lists included (`trusted-domains`, `blocked-domains`, `spam-traps`, `url-redirectors`), so the hold key is kept to
 * this namespace by the management proxy in production; this module only ever names it.
 */
import { StalwartError } from "./client";
import type { StalwartManagement } from "./management";

/** The hold's lookup namespace. */
export const RELAY_HOLD_NAMESPACE = "anhourmail-relay-hold";

/** The expression that is true for a held session. */
export const RELAY_HOLD_CONDITION = `key_exists('${RELAY_HOLD_NAMESPACE}', authenticated_as)`;

/** Stalwart's default `allowRelaying`: any authenticated session may relay. */
export const DEFAULT_RELAYING = "!is_empty(authenticated_as)";

type Expression = { match?: Record<string, { if?: string; then?: string }>; else?: string };

/** `x:MtaStageRcpt.allowRelaying` as it should be: the hold first, then the default. */
export function desiredRelaying(): { match: Record<string, { if: string; then: string }>; else: string } {
  return { match: { "0": { if: RELAY_HOLD_CONDITION, then: "false" } }, else: DEFAULT_RELAYING };
}

/** Whether an `allowRelaying` value refuses held accounts before anything else can allow them. */
export function isRelayHoldInPlace(expr: unknown): boolean {
  if (typeof expr !== "object" || expr === null) return false;
  const first = (expr as Expression).match?.["0"];
  return first?.if === RELAY_HOLD_CONDITION && first.then === "false";
}

/** Exactly the expression `desiredRelaying` writes (the reconciler's drift check). */
export function isDesiredRelaying(expr: unknown): boolean {
  if (!isRelayHoldInPlace(expr)) return false;
  const e = expr as Expression;
  return Object.keys(e.match ?? {}).length === 1 && e.else === DEFAULT_RELAYING;
}

const ADDRESS =
  /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The key for an address: lower case, and only a plain address (never a glob or anything quoted). */
export function relayHoldKey(address: string): string {
  const key = address.trim().toLowerCase();
  if (key.length > 255 || !ADDRESS.test(key)) throw new StalwartError("Relay hold keys must be plain addresses", "set");
  return key;
}

type LookupKey = { id: string; namespace?: string; key?: string; isGlobPattern?: boolean };

/** The id of the key already there, from Stalwart's `primaryKeyViolation` on a duplicate create; null otherwise. */
function existingId(err: unknown): string | null {
  if (!(err instanceof StalwartError) || err.kind !== "set" || typeof err.detail !== "object" || !err.detail) {
    return null;
  }
  for (const v of Object.values(err.detail as Record<string, unknown>)) {
    const refusal = v as { type?: unknown; objectId?: { id?: unknown } } | null;
    if (refusal?.type === "primaryKeyViolation" && typeof refusal.objectId?.id === "string") return refusal.objectId.id;
  }
  return null;
}

/**
 * The hold list on the mail server, with the hold key (`HOLD_KEY_PERMISSIONS`): `x:MemoryLookupKey` in
 * `RELAY_HOLD_NAMESPACE` and `ReloadLookupStores`. One instance per process: reloads are coalesced
 * (`reload`).
 *
 * Membership is looked up by writing: `x:MemoryLookupKey/query` filters by namespace only (a filter on `key` is
 * `unsupportedFilter`) and a duplicate create is refused with the existing key's id, so `add` and `remove` each cost one
 * or two calls whatever the list's size. A key written and destroyed again by `remove` was never loaded (no reload ran
 * in between), so the probe changes nothing the server enforces.
 */
export class RelayHoldList {
  #running: Promise<void> | null = null;
  #queued: Promise<void> | null = null;

  constructor(readonly mgmt: StalwartManagement) {}

  async #create(key: string): Promise<{ id: string; created: boolean }> {
    try {
      const { created } = await this.mgmt.transport.set("x:MemoryLookupKey", {
        create: { k: { namespace: RELAY_HOLD_NAMESPACE, key, isGlobPattern: false } },
      });
      const id = created.k?.id;
      if (typeof id !== "string") throw new StalwartError("Relay hold key was not created", "set");
      return { id, created: true };
    } catch (err) {
      const id = existingId(err);
      if (id === null) throw err;
      return { id, created: false };
    }
  }

  /** Puts the address on the list. True when it wasn't there (a reload is then needed before it holds). */
  async add(address: string): Promise<boolean> {
    return (await this.#create(relayHoldKey(address))).created;
  }

  /** Takes the address off the list. True when it was there (it keeps holding until the next reload). */
  async remove(address: string): Promise<boolean> {
    const { id, created } = await this.#create(relayHoldKey(address));
    await this.mgmt.transport.set("x:MemoryLookupKey", { destroy: [id] });
    return !created;
  }

  /** Every address on the list (the reconciler; one query by namespace, then the keys in pages). */
  async list(): Promise<string[]> {
    const ids = await this.mgmt.transport.queryAll("x:MemoryLookupKey", { namespace: RELAY_HOLD_NAMESPACE });
    if (ids.length === 0) return [];
    const keys = await this.mgmt.transport.getAll<LookupKey>("x:MemoryLookupKey", ["namespace", "key"], ids);
    return keys
      .filter((k) => k.namespace === RELAY_HOLD_NAMESPACE && typeof k.key === "string")
      .map((k) => k.key ?? "");
  }

  /** The `allowRelaying` expression the server holds (null when it can't be read with this credential). */
  async relaying(): Promise<unknown> {
    const [stage] = await this.mgmt.transport.getAll<{ id: string; allowRelaying?: unknown }>(
      "x:MtaStageRcpt",
      ["allowRelaying"],
      ["singleton"],
    );
    return stage?.allowRelaying ?? null;
  }

  /** Whether the server's `allowRelaying` holds listed accounts (checked before a held account is let send). */
  async inPlace(): Promise<boolean> {
    return isRelayHoldInPlace(await this.relaying());
  }

  /**
   * `ReloadLookupStores`, coalesced: a call made while a reload runs waits for the next one, which every such caller
   * shares and which starts only after the running one ends, so a reload that resolves a caller always began after that
   * caller's write. Stalwart answers once the reload is done (and refuses the call when it failed); throws then.
   */
  reload(): Promise<void> {
    if (!this.#running) {
      this.#running = this.#reloadOnce().finally(() => {
        this.#running = null;
      });
      return this.#running;
    }
    this.#queued ??= this.#running
      .catch(() => undefined)
      .then(() => {
        this.#queued = null;
        return this.reload();
      });
    return this.#queued;
  }

  async #reloadOnce(): Promise<void> {
    await this.mgmt.transport.set("x:Action", { create: { a: { "@type": "ReloadLookupStores" } } });
  }
}

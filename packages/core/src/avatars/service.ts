// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { AVATAR } from "@anhourmail/shared/profile";

import { type Actor, authorize, can } from "../actor";
import {
  BusyError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import { mutation, type MutationSpec } from "../mutation";
import { holdsPlatformRole } from "../people/names";
import {
  ACTING_PROFILE,
  actingAsStaff,
  type EditRefusal,
  editRefusal,
  memberOf,
  OTHER_ACCOUNT_PROFILE,
  ROLE_PROFILE,
} from "../people/profile-service";
import type { Deps, Repositories, RequestMeta } from "../ports";
import {
  type AvatarOwner,
  type AvatarRef,
  avatarVersion,
  isAvatarId,
  MAX_AVATAR_STORED_BYTES,
  MAX_AVATAR_UPLOAD_BYTES,
  sniffImage,
  type StoredAvatar,
} from "./entity";
import type { AvatarMailbox, ImageNormaliser, NormaliseFailure } from "./repository";

/**
 * Profile photos (ADR-0022; docs/internal/07-security.md "Profile photos").
 *
 * Who may change one:
 * - **a person's photo**: the person themself (`self.profile.manage`: console Profile page, their own person panel,
 *   or the webmail of one of their mailboxes while that mailbox's account is the only one they are in — `webmailRefusal`),
 *   and in an account the admins who may edit that person's profile
 *   (`member.manage` for a Member, an Owner for anyone else); someone who also belongs to another account is changed
 *   only by themself — the same rule as their profile details (`people/profile-service.ts`);
 * - **a person-less mailbox's photo** (a shared address): admins with `mailbox.manage`, or the mailbox itself from the
 *   webmail. A mailbox with a person shows the person's photo and has none of its own to change.
 *
 * Who may see one: the person, the people in their accounts who may see people (`member.read`) or mailboxes
 * (`mailbox.read`), staff who may look up accounts (`platform.accounts.read`), and webmail sessions of mailboxes in
 * the same account. Anyone else gets a 404, never a hint the photo exists.
 *
 * Every change is audited (`account.avatar_changed` / `_removed` for a person, `mailbox.avatar_changed` / `_removed`
 * for a mailbox) with the stored size only, never the image. A person's own change is copied into each of their
 * accounts' logs, like their profile details.
 */

const EMPTY = "Choose an image.";
const TOO_BIG = `Choose an image up to ${String(AVATAR.maxUploadMb)} MB.`;
const BAD_TYPE = "Use a PNG, JPEG or WebP image.";
const FAILURES: Record<Exclude<NormaliseFailure, "busy">, string> = {
  not_image: BAD_TYPE,
  animated: "Use a still image, not an animation.",
  too_small: `Use an image at least ${String(AVATAR.minSide)} pixels wide and tall.`,
  too_large: `Use an image at most ${String(AVATAR.maxSide)} pixels wide and tall.`,
  decode_failed: "That image couldn't be read. Try another, or save it again as PNG or JPEG.",
};

export const PERSON_MAILBOX =
  "This mailbox belongs to a person, so it shows their photo. Change it on their profile instead.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A normalised photo ready to store. */
export type PreparedAvatar = { contentType: "image/webp"; bytes: Uint8Array; sha256: string };

/**
 * Checks an upload and re-encodes it: size, then magic bytes (PNG, JPEG or WebP only; SVG, HTML, GIF and polyglots
 * with any other start are refused before decoding), then the image adapter decodes it, crops it to a square and
 * writes a metadata-free WebP. The result is checked again (a WebP, within the stored-size cap) before it is kept.
 */
export async function prepareAvatar(images: ImageNormaliser, input: Uint8Array): Promise<PreparedAvatar> {
  if (input.length === 0) throw new ValidationError(EMPTY);
  if (input.length > MAX_AVATAR_UPLOAD_BYTES) throw new ValidationError(TOO_BIG);
  if (sniffImage(input) === null) throw new ValidationError(BAD_TYPE);
  const out = await images.normalise(input, { size: AVATAR.size, minSide: AVATAR.minSide, maxSide: AVATAR.maxSide });
  if (!out.ok) {
    if (out.reason === "busy") throw new BusyError("Many photos are being processed. Try again in a moment.");
    throw new ValidationError(FAILURES[out.reason]);
  }
  if (sniffImage(out.bytes) !== "webp" || out.bytes.length > MAX_AVATAR_STORED_BYTES) {
    throw new ValidationError(FAILURES.decode_failed);
  }
  return {
    contentType: "image/webp",
    bytes: out.bytes,
    sha256: createHash("sha256").update(out.bytes).digest("hex"),
  };
}

const selfId = (actor: Actor): string | null => (actor.kind === "user" ? actor.userId : null);

type Resolved = { owner: AvatarOwner; label: string; meta: Record<string, unknown>; copies: string[] };
/** Why a change is refused (403, audited as denied with this code; `role` is recorded as `forbidden`). */
type Refusal = EditRefusal | "not_member" | "act_as";
type Resolution = Resolved | { refusal: Refusal; label: string | null; message?: string };
type Change = { set: Uint8Array; images: ImageNormaliser } | { remove: true };
type Outcome = { ref: AvatarRef | null } | { refused: Refusal; message?: string };

/**
 * One photo change. `resolve` finds the owner inside the unit of work (scope, role and other-account rules) and runs
 * twice for an upload: once read-only before decoding, so a refused or out-of-scope request never costs an image
 * decode and no transaction is held open while decoding, and again in the transaction that writes.
 */
async function changeAvatar(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  resolve: (repos: Repositories) => Promise<Resolution>,
  change: Change,
): Promise<AvatarRef | null> {
  let prepared: PreparedAvatar | ValidationError | undefined;
  if ("set" in change && can(actor, spec.permission, spec.accountId ?? undefined)) {
    const pre = await deps.uow.run(resolve).catch(() => null);
    if (pre && !("refusal" in pre)) {
      prepared = await prepareAvatar(change.images, change.set).catch((err: unknown) => {
        if (err instanceof ValidationError) return err;
        throw err;
      });
    }
  }
  const out = await mutation<Outcome>(deps, actor, req, spec, async (repos) => {
    const r = await resolve(repos);
    if ("refusal" in r) {
      return {
        result: { refused: r.refusal, ...(r.message ? { message: r.message } : {}) },
        target: { label: r.label },
        denied: { code: r.refusal === "role" ? "forbidden" : r.refusal },
      };
    }
    const target = { id: r.owner.id, label: r.label };
    if ("remove" in change) {
      const meta = { ...r.meta, removed: await repos.avatars.remove(r.owner) };
      return { result: { ref: null }, target, meta, copies: r.copies.map((accountId) => ({ accountId, meta })) };
    }
    if (prepared === undefined) throw new ConflictError("Something changed meanwhile. Try again.");
    if (prepared instanceof ValidationError) throw prepared;
    await repos.avatars.set(r.owner, prepared, deps.clock.now());
    // The stored size only: never the image, its hash or anything read from it.
    const meta = { ...r.meta, bytes: prepared.bytes.length };
    return {
      result: { ref: { ...r.owner, version: avatarVersion(prepared.sha256) } },
      target,
      meta,
      copies: r.copies.map((accountId) => ({ accountId, meta })),
    };
  });
  if ("refused" in out) {
    throw new ForbiddenError(out.message ?? (out.refused === "role" ? ROLE_PROFILE : OTHER_ACCOUNT_PROFILE));
  }
  return out.ref;
}

const personAction = (change: Change) => ("set" in change ? "account.avatar_changed" : "account.avatar_removed");
const mailboxAction = (change: Change) => ("set" in change ? "mailbox.avatar_changed" : "mailbox.avatar_removed");

/**
 * The accounts a person is a member of now. Only memberships count: removing someone from an account keeps their
 * mailboxes' owner link (`mailbox.user_id`), but that former account no longer sees or changes their photo.
 */
async function personAccounts(repos: Repositories, userId: string): Promise<string[]> {
  return [...new Set((await repos.access.memberships(userId)).map((m) => m.accountId))];
}

/**
 * Whose photo each mailbox shows: its person's while they are a member of the mailbox's account, its own when it has
 * no person, none (null) when its person has left the account.
 */
async function currentOwners(
  repos: Repositories,
  boxes: readonly AvatarMailbox[],
): Promise<Map<string, AvatarOwner | null>> {
  const members = new Map<string, Set<string>>();
  for (const accountId of new Set(boxes.filter((b) => b.userId !== null).map((b) => b.accountId))) {
    members.set(accountId, new Set((await repos.people.list(accountId)).map((m) => m.userId)));
  }
  return new Map(
    boxes.map((b): [string, AvatarOwner | null] => [
      b.id,
      b.userId === null
        ? { kind: "mailbox", id: b.id }
        : members.get(b.accountId)?.has(b.userId)
          ? { kind: "person", id: b.userId }
          : null,
    ]),
  );
}

// ---- the console --------------------------------------------------------------------------------------------

function ownChange(deps: Deps, actor: Actor, req: RequestMeta, change: Change) {
  const accounts = actor.kind === "user" ? [...new Set(actor.memberships.map((m) => m.accountId))] : [];
  const [first, ...rest] = accounts;
  return changeAvatar(
    deps,
    actor,
    req,
    {
      action: personAction(change),
      permission: "self.profile.manage",
      accountId: first ?? null,
      target: { type: "person", id: selfId(actor) },
    },
    async () => {
      if (actor.kind !== "user") throw new UnauthenticatedError();
      if (actingAsStaff(actor)) return { refusal: "act_as", label: actor.email, message: ACTING_PROFILE };
      return { owner: { kind: "person", id: actor.userId }, label: actor.email, meta: { self: true }, copies: rest };
    },
    change,
  );
}

/** The person's own photo, from their Profile page (`self.profile.manage`). */
export function setOwnAvatar(
  deps: Deps,
  images: ImageNormaliser,
  actor: Actor,
  bytes: Uint8Array,
  req: RequestMeta,
): Promise<AvatarRef | null> {
  return ownChange(deps, actor, req, { set: bytes, images });
}

export function removeOwnAvatar(deps: Deps, actor: Actor, req: RequestMeta): Promise<AvatarRef | null> {
  return ownChange(deps, actor, req, { remove: true });
}

function personChange(deps: Deps, actor: Actor, req: RequestMeta, accountId: string, userId: string, change: Change) {
  const own = userId === selfId(actor);
  return changeAvatar(
    deps,
    actor,
    req,
    {
      action: personAction(change),
      // Your own photo is yours to change whatever your role; you still have to be in the account (404 otherwise).
      permission: own ? "self.profile.manage" : "member.manage",
      accountId,
      target: { type: "person", id: userId },
    },
    async (repos) => {
      if (actingAsStaff(actor)) return { refusal: "act_as", label: null, message: ACTING_PROFILE };
      if (own && !(actor.kind === "user" && actor.memberships.some((m) => m.accountId === accountId))) {
        throw new NotFoundError();
      }
      const target = await memberOf(repos, accountId, userId);
      const refusal = await editRefusal(repos, actor, accountId, target);
      if (refusal !== null) return { refusal, label: target.email };
      const copies = own ? (await personAccounts(repos, userId)).filter((a) => a !== accountId) : [];
      return { owner: { kind: "person", id: userId }, label: target.email, meta: { self: own }, copies };
    },
    change,
  );
}

/** A person's photo from an account's People page (the profile edit rule; the person themself always may). */
export function setPersonAvatar(
  deps: Deps,
  images: ImageNormaliser,
  actor: Actor,
  accountId: string,
  userId: string,
  bytes: Uint8Array,
  req: RequestMeta,
): Promise<AvatarRef | null> {
  return personChange(deps, actor, req, accountId, userId, { set: bytes, images });
}

export function removePersonAvatar(
  deps: Deps,
  actor: Actor,
  accountId: string,
  userId: string,
  req: RequestMeta,
): Promise<AvatarRef | null> {
  return personChange(deps, actor, req, accountId, userId, { remove: true });
}

function mailboxChange(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  accountId: string,
  mailboxId: string,
  change: Change,
) {
  return changeAvatar(
    deps,
    actor,
    req,
    {
      action: mailboxAction(change),
      permission: "mailbox.manage",
      accountId,
      target: { type: "mailbox", id: mailboxId },
    },
    async (repos) => {
      const m = UUID.test(mailboxId) ? await repos.mailboxes.get(accountId, mailboxId) : null;
      if (!m) throw new NotFoundError();
      if (m.userId !== null) throw new ConflictError(PERSON_MAILBOX);
      return { owner: { kind: "mailbox", id: m.id }, label: m.address, meta: {}, copies: [] };
    },
    change,
  );
}

/** A person-less mailbox's photo, from the Mailboxes page (`mailbox.manage`). */
export function setMailboxAvatar(
  deps: Deps,
  images: ImageNormaliser,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  bytes: Uint8Array,
  req: RequestMeta,
): Promise<AvatarRef | null> {
  return mailboxChange(deps, actor, req, accountId, mailboxId, { set: bytes, images });
}

export function removeMailboxAvatar(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  req: RequestMeta,
): Promise<AvatarRef | null> {
  return mailboxChange(deps, actor, req, accountId, mailboxId, { remove: true });
}

// ---- the webmail --------------------------------------------------------------------------------------------

const norm = (address: string) => address.trim().toLowerCase();

/** In the webmail: a person's photo is changed only from the console when it shows in more than one account. */
export const WEBMAIL_OTHER_ACCOUNT =
  "Your photo is shown in more than one account, so change it from Profile in the console.";
export const WEBMAIL_NOT_MEMBER =
  "This mailbox's person is no longer in its account, so its photo can't be changed here. Ask an admin of the account.";

/**
 * Whether the webmail of a mailbox may change the photo it shows, or why not. A mailbox password can be reset by an
 * admin of the mailbox's account, so the webmail may change a person's photo only when that account is the only one
 * they are in — the same rule as the console's (`editRefusal`'s `other_account`): otherwise only the person, signed in
 * to the console, may.
 */
async function webmailRefusal(repos: Repositories, m: AvatarMailbox): Promise<Refusal | null> {
  if (m.userId === null) return null;
  const accounts = await personAccounts(repos, m.userId);
  if (!accounts.includes(m.accountId)) return "not_member";
  // Staff (any platform role) count as being elsewhere too (`holdsPlatformRole`).
  return accounts.length > 1 || (await holdsPlatformRole(repos, m.userId)) ? "other_account" : null;
}

async function webmailChange(deps: Deps, address: string, req: RequestMeta, change: Change) {
  // The webmail session proved the mailbox's password with the mail server; the actor is that mailbox (as for the
  // other webmail settings).
  const actor: Actor = { kind: "system", name: norm(address) };
  const [m] = await deps.uow.run((r) => r.avatars.mailboxesByAddress([norm(address)]));
  if (!m) throw new NotFoundError();
  const person = m.userId;
  return changeAvatar(
    deps,
    actor,
    req,
    person !== null
      ? {
          action: personAction(change),
          permission: "self.profile.manage",
          accountId: m.accountId,
          target: { type: "person", id: person },
        }
      : {
          action: mailboxAction(change),
          permission: "mailbox.read",
          accountId: m.accountId,
          target: { type: "mailbox", id: m.id, label: m.address },
        },
    async (repos) => {
      const [cur] = await repos.avatars.mailboxesByAddress([m.address]);
      if (cur?.id !== m.id || cur.userId !== person)
        throw new ConflictError("This mailbox changed meanwhile. Try again.");
      if (person === null) {
        return { owner: { kind: "mailbox", id: m.id }, label: m.address, meta: { via: "webmail" }, copies: [] };
      }
      const email = (await repos.suspensions.personInfo(person))?.email ?? m.address;
      const refusal = await webmailRefusal(repos, m);
      if (refusal !== null) {
        return {
          refusal,
          label: email,
          message: refusal === "not_member" ? WEBMAIL_NOT_MEMBER : WEBMAIL_OTHER_ACCOUNT,
        };
      }
      // Only one account (checked above): its log is the one entry.
      return { owner: { kind: "person", id: person }, label: email, meta: { self: true, via: "webmail" }, copies: [] };
    },
    change,
  );
}

/**
 * The photo shown for a webmail session's mailbox: its person's photo when it has one (the same photo as the console
 * Profile page), else the mailbox's own.
 */
export function setWebmailAvatar(
  deps: Deps,
  images: ImageNormaliser,
  address: string,
  bytes: Uint8Array,
  req: RequestMeta,
): Promise<AvatarRef | null> {
  return webmailChange(deps, address, req, { set: bytes, images });
}

export function removeWebmailAvatar(deps: Deps, address: string, req: RequestMeta): Promise<AvatarRef | null> {
  return webmailChange(deps, address, req, { remove: true });
}

// ---- reading ------------------------------------------------------------------------------------------------

/** The signed-in person's own photo, if any (the console app bar and Profile page). */
export async function ownAvatar(deps: Deps, actor: Actor): Promise<AvatarRef | null> {
  authorize(actor, "self.profile.read");
  if (actor.kind !== "user") throw new UnauthenticatedError();
  const userId = actor.userId;
  return deps.uow.run(async (r) => (await r.avatars.versions([{ kind: "person", id: userId }]))[0] ?? null);
}

/** Photo versions by person id and by (person-less) mailbox id. */
export type AvatarVersions = { people: Record<string, string>; mailboxes: Record<string, string> };

const byKind = (refs: AvatarRef[]): AvatarVersions => {
  const out: AvatarVersions = { people: {}, mailboxes: {} };
  for (const r of refs) (r.kind === "person" ? out.people : out.mailboxes)[r.id] = r.version;
  return out;
};

const unique = (owners: AvatarOwner[]): AvatarOwner[] => {
  const seen = new Set<string>();
  return owners.filter((o) => {
    const key = `${o.kind}:${o.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The photos of an account's people (with `member.read`) and of its mailboxes (with `mailbox.read`; a mailbox with a
 * person shows the person's), for its People and Mailboxes pages; staff who may look up accounts see both. Someone
 * with neither gets the People page's answer (404 outside the account, 403 inside).
 */
export async function accountAvatars(deps: Deps, actor: Actor, accountId: string): Promise<AvatarVersions> {
  const staff = can(actor, "platform.accounts.read");
  const people = staff || can(actor, "member.read", accountId);
  const boxes = staff || can(actor, "mailbox.read", accountId);
  if (!people && !boxes) authorize(actor, "member.read", accountId);
  return deps.uow.run(async (r) => {
    const members = await r.people.list(accountId);
    const memberIds = new Set(members.map((m) => m.userId));
    const mailboxes = boxes ? await r.mailboxes.listByAccount(accountId) : [];
    const owners = unique([
      ...(people ? members.map((m): AvatarOwner => ({ kind: "person", id: m.userId })) : []),
      // A mailbox shows its person's photo while they are a member here, else (no person) its own.
      ...mailboxes.flatMap((m): AvatarOwner[] =>
        m.userId === null
          ? [{ kind: "mailbox", id: m.id }]
          : memberIds.has(m.userId)
            ? [{ kind: "person", id: m.userId }]
            : [],
      ),
    ]);
    return byKind(owners.length > 0 ? await r.avatars.versions(owners) : []);
  });
}

/**
 * A photo for the console (`GET /api/avatars/:kind/:id`): the viewer must be signed in (401) and not suspended (403),
 * then be the person, or may see people or mailboxes in an account the owner is in, or be staff who may look up
 * accounts. Someone in that account without the permission gets 403; anyone else, or a photo that doesn't exist, 404.
 */
export async function avatarImage(deps: Deps, actor: Actor, owner: AvatarOwner | null): Promise<StoredAvatar> {
  // Signed in and not suspended first (401 / 403), then the id (404).
  authorize(actor, "self.profile.read");
  if (!owner || !isAvatarId(owner.id)) throw new NotFoundError();
  return deps.uow.run(async (r) => {
    let accounts: string[];
    if (owner.kind === "person") {
      accounts = await personAccounts(r, owner.id);
    } else {
      const m = await r.avatars.mailboxById(owner.id);
      accounts = m ? [m.accountId] : [];
    }
    const allowed =
      (owner.kind === "person" && owner.id === selfId(actor)) ||
      can(actor, "platform.accounts.read") ||
      accounts.some((a) => can(actor, "mailbox.read", a) || (owner.kind === "person" && can(actor, "member.read", a)));
    if (!allowed) {
      const inside = actor.kind === "user" && accounts.some((a) => actor.memberships.some((m) => m.accountId === a));
      throw inside ? new ForbiddenError() : new NotFoundError();
    }
    const image = await r.avatars.get(owner);
    if (!image) throw new NotFoundError();
    return image;
  });
}

/** The most mailboxes one webmail session holds that we look at, and addresses per lookup. */
const MAX_SESSION_ADDRESSES = 20;
export const MAX_AVATAR_LOOKUP = 100;

/**
 * A webmail session mailbox's photo: whose it is (null when its person has left the account: initials only), the
 * photo, and whether this webmail may change it (`webmailRefusal`).
 */
export type WebmailAvatar = { address: string; owner: AvatarOwner | null; ref: AvatarRef | null; editable: boolean };

/** The photo shown for each of a webmail session's mailboxes (its person's, else its own), in the given order. */
export async function webmailOwnAvatars(deps: Deps, addresses: readonly string[]): Promise<WebmailAvatar[]> {
  const wanted = [...new Set(addresses.map(norm))].slice(0, MAX_SESSION_ADDRESSES);
  return deps.uow.run(async (r) => {
    const boxes = await r.avatars.mailboxesByAddress(wanted);
    const owners = await currentOwners(r, boxes);
    const known = [...owners.values()].filter((o): o is AvatarOwner => o !== null);
    const refs = known.length > 0 ? await r.avatars.versions(unique(known)) : [];
    const out: WebmailAvatar[] = [];
    for (const address of wanted) {
      const m = boxes.find((b) => b.address === address);
      if (!m) continue;
      const owner = owners.get(m.id) ?? null;
      const ref = owner ? (refs.find((x) => x.kind === owner.kind && x.id === owner.id) ?? null) : null;
      out.push({ address, owner, ref, editable: (await webmailRefusal(r, m)) === null });
    }
    return out;
  });
}

/** The accounts of a webmail session's mailboxes. */
async function sessionAccounts(r: Repositories, addresses: readonly string[]): Promise<Set<string>> {
  const boxes = await r.avatars.mailboxesByAddress([...new Set(addresses.map(norm))].slice(0, MAX_SESSION_ADDRESSES));
  return new Set(boxes.map((m) => m.accountId));
}

/**
 * Photos for addresses the webmail shows (senders and recipients of loaded messages, contacts): only mailboxes in the
 * same account as one of the session's mailboxes, so it never reveals anything about other accounts' addresses.
 */
export async function webmailAvatarLookup(
  deps: Deps,
  sessionAddresses: readonly string[],
  lookup: readonly string[],
): Promise<Record<string, AvatarRef>> {
  const wanted = [...new Set(lookup.map(norm))].slice(0, MAX_AVATAR_LOOKUP);
  if (wanted.length === 0) return {};
  return deps.uow.run(async (r) => {
    const accounts = await sessionAccounts(r, sessionAddresses);
    const boxes = (await r.avatars.mailboxesByAddress(wanted)).filter((m) => accounts.has(m.accountId));
    if (boxes.length === 0) return {};
    const owners = await currentOwners(r, boxes);
    const known = [...owners.values()].filter((o): o is AvatarOwner => o !== null);
    const refs = known.length > 0 ? await r.avatars.versions(unique(known)) : [];
    const out: Record<string, AvatarRef> = {};
    for (const m of boxes) {
      const owner = owners.get(m.id);
      const ref = owner ? refs.find((x) => x.kind === owner.kind && x.id === owner.id) : undefined;
      if (ref) out[m.address] = ref;
    }
    return out;
  });
}

/** A photo for the webmail (`GET /api/webmail/avatars/:kind/:id`): only owners in the session's mailboxes' accounts. */
export async function webmailAvatarImage(
  deps: Deps,
  sessionAddresses: readonly string[],
  owner: AvatarOwner,
): Promise<StoredAvatar> {
  if (!isAvatarId(owner.id)) throw new NotFoundError();
  return deps.uow.run(async (r) => {
    const accounts = await sessionAccounts(r, sessionAddresses);
    const theirs =
      owner.kind === "person"
        ? await personAccounts(r, owner.id)
        : [(await r.avatars.mailboxById(owner.id))?.accountId].filter((a) => a !== undefined);
    if (!theirs.some((a) => accounts.has(a))) throw new NotFoundError();
    const image = await r.avatars.get(owner);
    if (!image) throw new NotFoundError();
    return image;
  });
}

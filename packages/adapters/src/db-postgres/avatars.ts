// SPDX-License-Identifier: AGPL-3.0-only
import { eq, inArray, or, type SQL } from "drizzle-orm";

import {
  type AvatarContentType,
  type AvatarMailbox,
  type AvatarOwner,
  type AvatarRef,
  type AvatarRepository,
  avatarVersion,
  type StoredAvatar,
} from "@anhourmail/core/avatars";

import type { Executor } from "./client";
import { avatar, mailbox } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row condition for an owner; null when the id can't be one (a mailbox id that isn't a uuid). */
function ownerWhere(owner: AvatarOwner): SQL | null {
  if (owner.kind === "person") return eq(avatar.userId, owner.id);
  return UUID.test(owner.id) ? eq(avatar.mailboxId, owner.id) : null;
}

const mailboxFields = {
  id: mailbox.id,
  accountId: mailbox.accountId,
  address: mailbox.address,
  userId: mailbox.userId,
};

/** Profile photos (ADR-0022): the `avatar` table, one row per person or person-less mailbox. */
export class PgAvatarRepository implements AvatarRepository {
  constructor(private readonly x: Executor) {}

  async get(owner: AvatarOwner): Promise<StoredAvatar | null> {
    const where = ownerWhere(owner);
    if (!where) return null;
    const [r] = await this.x.select().from(avatar).where(where).limit(1);
    if (!r) return null;
    return {
      owner: { kind: owner.kind, id: owner.id },
      contentType: r.contentType as AvatarContentType,
      bytes: r.data,
      sha256: r.sha256,
      updatedAt: r.updatedAt,
    };
  }

  async versions(owners: readonly AvatarOwner[]): Promise<AvatarRef[]> {
    const people = owners.filter((o) => o.kind === "person").map((o) => o.id);
    const boxes = owners.filter((o) => o.kind === "mailbox" && UUID.test(o.id)).map((o) => o.id);
    const conds = [
      ...(people.length > 0 ? [inArray(avatar.userId, people)] : []),
      ...(boxes.length > 0 ? [inArray(avatar.mailboxId, boxes)] : []),
    ];
    if (conds.length === 0) return [];
    const rows = await this.x
      .select({ userId: avatar.userId, mailboxId: avatar.mailboxId, sha256: avatar.sha256 })
      .from(avatar)
      .where(or(...conds));
    return rows.flatMap((r): AvatarRef[] => {
      if (r.userId !== null) return [{ kind: "person", id: r.userId, version: avatarVersion(r.sha256) }];
      if (r.mailboxId !== null) return [{ kind: "mailbox", id: r.mailboxId, version: avatarVersion(r.sha256) }];
      return [];
    });
  }

  async set(
    owner: AvatarOwner,
    image: { contentType: AvatarContentType; bytes: Uint8Array; sha256: string },
    at: Date,
  ): Promise<void> {
    if (owner.kind === "mailbox" && !UUID.test(owner.id)) throw new Error("not a mailbox id");
    const values = {
      contentType: image.contentType,
      data: image.bytes,
      byteSize: image.bytes.length,
      sha256: image.sha256,
      updatedAt: at,
    };
    await this.x
      .insert(avatar)
      .values(owner.kind === "person" ? { ...values, userId: owner.id } : { ...values, mailboxId: owner.id })
      .onConflictDoUpdate({ target: owner.kind === "person" ? avatar.userId : avatar.mailboxId, set: values });
  }

  async remove(owner: AvatarOwner): Promise<boolean> {
    const where = ownerWhere(owner);
    if (!where) return false;
    const rows = await this.x.delete(avatar).where(where).returning({ id: avatar.id });
    return rows.length > 0;
  }

  async mailboxesByAddress(addresses: readonly string[]): Promise<AvatarMailbox[]> {
    const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => a.length <= 320);
    if (wanted.length === 0) return [];
    return this.x.select(mailboxFields).from(mailbox).where(inArray(mailbox.address, wanted));
  }

  async mailboxById(id: string): Promise<AvatarMailbox | null> {
    if (!UUID.test(id)) return null;
    const [r] = await this.x.select(mailboxFields).from(mailbox).where(eq(mailbox.id, id)).limit(1);
    return r ?? null;
  }
}

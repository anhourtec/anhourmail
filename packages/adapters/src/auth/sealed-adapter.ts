// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Seals TOTP secrets with our key ring (CLAUDE.md rule 16; docs/internal/07-security.md "Sign-in factors").
 *
 * better-auth's two-factor plugin already encrypts the secret with BETTER_AUTH_SECRET before writing it. This wraps
 * the database adapter so `twoFactor.secret` is sealed again on the way in — AES-256-GCM from the key ring, bound to
 * the row's user id (AAD), so a copied value can't be moved to another person's row — and unsealed on the way out. The
 * plugin never notices. Nothing else is touched: recovery codes are stored as hashes (`recovery-codes.ts`).
 */
type Row = Record<string, unknown>;

/** The part of `@anhourmail/server/keyring` this needs (passed in by the app). */
export type Sealer = {
  encrypt(purpose: string, plaintext: string, aad: string): string;
  decrypt(purpose: string, sealed: string, aad: string): string;
};

const MODEL = "twoFactor";
const PURPOSE = "auth.two_factor.secret";
const aadFor = (userId: string) => `auth_two_factor:${userId}`;
const isSealed = (v: string) => v.startsWith("v1.");

type AnyFn = (...args: never[]) => Promise<unknown>;
type Adapter = Record<string, unknown> & {
  findOne: (q: { model: string; where: unknown[] }) => Promise<unknown>;
};

export function sealTwoFactorSecrets<A extends object>(inner: A, sealer: Sealer): A {
  const adapter = inner as unknown as Adapter;

  const seal = (data: Row, userId: unknown): Row => {
    if (typeof data.secret !== "string" || isSealed(data.secret)) return data;
    if (typeof userId !== "string" || userId === "") throw new Error("two-factor secret without a user");
    return { ...data, secret: sealer.encrypt(PURPOSE, data.secret, aadFor(userId)) };
  };

  const unsealRow = (row: unknown): unknown => {
    if (!row || typeof row !== "object") return row;
    const r = row as Row;
    if (typeof r.secret !== "string" || !isSealed(r.secret) || typeof r.userId !== "string") return row;
    return { ...r, secret: sealer.decrypt(PURPOSE, r.secret, aadFor(r.userId)) };
  };
  const unseal = (out: unknown): unknown => (Array.isArray(out) ? out.map(unsealRow) : unsealRow(out));

  const wrap = (target: Adapter): Adapter => {
    const call = (name: string) => target[name] as AnyFn;
    const out: Adapter = { ...target };
    out.create = async (q: { model: string; data: Row }) => {
      const data = q.model === MODEL ? seal(q.data, q.data.userId) : q.data;
      const res = await call("create")({ ...q, data } as never);
      return q.model === MODEL ? unseal(res) : res;
    };
    for (const name of ["update", "updateMany"] as const) {
      out[name] = async (q: { model: string; where: unknown[]; update: Row }) => {
        if (q.model !== MODEL || typeof q.update.secret !== "string") {
          const res = await call(name)(q as never);
          return q.model === MODEL ? unseal(res) : res;
        }
        // The AAD is the row's user id: read it first (updates address the row by id).
        const current = (await target.findOne({ model: MODEL, where: q.where })) as Row | null;
        const res = await call(name)({ ...q, update: seal(q.update, q.update.userId ?? current?.userId) } as never);
        return unseal(res);
      };
    }
    for (const name of ["findOne", "findMany", "consumeOne", "incrementOne"] as const) {
      if (typeof target[name] !== "function") continue;
      out[name] = async (q: { model: string }) => {
        const res = await call(name)(q as never);
        return q.model === MODEL ? unseal(res) : res;
      };
    }
    if (typeof target.transaction === "function") {
      out.transaction = async (cb: (trx: Adapter) => Promise<unknown>) =>
        call("transaction")(((trx: Adapter) => cb(wrap(trx))) as never);
    }
    return out;
  };

  return wrap(adapter) as unknown as A;
}

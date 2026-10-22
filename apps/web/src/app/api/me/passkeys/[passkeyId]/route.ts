// SPDX-License-Identifier: AGPL-3.0-only
import { removePasskey, renamePasskey } from "@anhourmail/core/security";

import { getActor } from "@/server/auth/actor";
import { container } from "@/server/container";
import { ok, readJson, route } from "@/server/http/route";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Renames one of the person's passkeys (`self.security.manage`). Someone else's passkey id is a 404. */
export const PATCH = route(async ({ req, meta }, params) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const p = await renamePasskey(
    container().deps,
    await getActor(req.headers),
    { passkeyId: str(params.passkeyId), name: body.name },
    meta,
  );
  return ok({ id: p.id, name: p.name });
});

/**
 * Removes one of the person's passkeys (`self.security.manage`). 409 when an account requirement depends on it;
 * someone else's passkey id is a 404.
 */
export const DELETE = route(
  async ({ req, meta }, params) => {
    await removePasskey(container().deps, await getActor(req.headers), { passkeyId: str(params.passkeyId) }, meta);
    return ok({ removed: true });
  },
  { limit: "sensitive" },
);

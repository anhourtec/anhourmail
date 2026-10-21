// SPDX-License-Identifier: MIT
import { StalwartTransport } from "./client";
import { StalwartManagement } from "./management";

export {
  type MethodCall,
  type StalwartAuth,
  type StalwartClientOptions,
  StalwartError,
  StalwartTransport,
} from "./client";
export { type DomainInput, type RelayRouteInput, StalwartManagement, type UserInput } from "./management";

const globalForStalwart = globalThis as unknown as { amStalwart?: StalwartManagement };

/**
 * The shared management client, configured from the environment:
 * STALWART_URL plus STALWART_API_KEY (production), or STALWART_DEV_ADMIN_USER / _PASSWORD (dev only).
 */
export function stalwart(): StalwartManagement {
  if (!globalForStalwart.amStalwart) {
    const baseUrl = process.env.STALWART_URL;
    if (!baseUrl) throw new Error("STALWART_URL is not set");
    const token = process.env.STALWART_API_KEY;
    const username = process.env.STALWART_DEV_ADMIN_USER;
    const password = process.env.STALWART_DEV_ADMIN_PASSWORD;
    const auth =
      token !== undefined && token !== ""
        ? ({ type: "bearer", token } as const)
        : username && password
          ? ({ type: "basic", username, password } as const)
          : null;
    if (!auth) throw new Error("Set STALWART_API_KEY (or the dev admin credentials)");
    globalForStalwart.amStalwart = new StalwartManagement(new StalwartTransport({ baseUrl, auth }));
  }
  return globalForStalwart.amStalwart;
}

/**
 * Creates an app password as the mailbox user (Stalwart doesn't let admins mint them). Returns the secret,
 * which Stalwart shows once — the caller hands it to the user and never stores it (CLAUDE.md rule 23).
 */
export async function createAppPassword(input: {
  baseUrl: string;
  address: string;
  password: string;
  description: string;
}): Promise<string> {
  const t = new StalwartTransport({
    baseUrl: input.baseUrl,
    auth: { type: "basic", username: input.address, password: input.password },
  });
  const { created } = await t.set("x:AppPassword", { create: { a: { description: input.description } } });
  const secret = created.a?.secret;
  if (typeof secret !== "string") throw new Error("App password was not returned");
  return secret;
}

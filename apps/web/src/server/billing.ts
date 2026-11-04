// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { billingRedirectOrigins } from "@anhourmail/adapters/billing";
import type { BillingContext } from "@anhourmail/core/billing";

import { container } from "./container";
import { env } from "./env";

/**
 * What the billing services get from the app (ADR-0029 §9): the provider (null when billing is off), the console
 * origin checkout and the portal return to, and the only origins a provider URL may have (no open redirect).
 */
export function billingContext(): BillingContext {
  const provider = container().billing ?? null;
  const appUrl = env().APP_URL;
  return { provider, appUrl, redirectOrigins: billingRedirectOrigins(provider, appUrl) };
}

export const paramOf = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

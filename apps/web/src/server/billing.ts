// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { z } from "zod";

import { billingProviderKind, billingRedirectOrigins } from "@anhourmail/adapters/billing";
import type { BillingContext } from "@anhourmail/core/billing";
import { BILLING } from "@anhourmail/shared/plans";

import { container } from "./container";
import { env } from "./env";

/**
 * What the billing services get from the app (ADR-0029 §9): the provider (null when billing is off), the console
 * origin checkout and the portal return to, and the only origins a provider URL may have (no open redirect).
 */
export function billingContext(): BillingContext {
  const provider = container().billing ?? null;
  const appUrl = env().APP_URL;
  return {
    provider,
    appUrl,
    redirectOrigins: billingRedirectOrigins(provider, appUrl),
    // The same rule as the page (run-67 N3): the server refuses buying while paid plans aren't open here.
    paidPlansOpen: billingOffered(BILLING.status, provider !== null).offered,
  };
}

/**
 * Whether the Billing page may offer paid plans (ADR-0029 §3): billing must be on, and while `BILLING.status` is
 * `planned` only a test setup (the dev fake, or the processor with test keys on pre-staging) can be used, so a
 * deployment that isn't open yet never takes a real payment from the page. The services still answer the API either
 * way; production starts with billing `off` (503 `billing_unavailable`).
 */
export function billingOffered(status: "planned" | "open", available: boolean): { offered: boolean; test: boolean } {
  return paidPlansOffered(status, available, { ...process.env, NODE_ENV: env().NODE_ENV });
}

/** `billingOffered` over a given environment (pure; unit-tested). */
export function paidPlansOffered(
  status: "planned" | "open",
  available: boolean,
  e: Record<string, string | undefined>,
): { offered: boolean; test: boolean } {
  const kind = billingProviderKind(e);
  const test = kind === "fake" || (kind === "stripe" && /^(?:sk|rk)_test_/.test((e.STRIPE_SECRET_KEY ?? "").trim()));
  return { offered: available && (status === "open" || test), test };
}

export const paramOf = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/** A plan or add-on change, shape only (the service checks plans, amounts and quantities against the facts). */
export const ChangeBody = z.object({
  plan: z.string().max(20).optional(),
  supporterAmountMinor: z.number().optional(),
  storageBlocks: z.number().optional(),
  extraMailboxes: z.number().optional(),
});

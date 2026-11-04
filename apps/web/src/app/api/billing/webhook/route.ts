// SPDX-License-Identifier: AGPL-3.0-only
import { receiveBillingWebhook } from "@/server/billing-webhook";
import { route } from "@/server/http/route";

export const dynamic = "force-dynamic";

/**
 * The billing provider's webhook (ADR-0029 §4): outside the session, signed by the provider (no same-origin check),
 * tier `webhook` per client address (fail open: the signature is the real gate).
 */
export const POST = route(({ req }) => receiveBillingWebhook(req), { limit: "webhook", origin: "signed" });

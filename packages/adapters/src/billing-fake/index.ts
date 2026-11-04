// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from "node:crypto";

export {
  createFakeBillingProvider,
  eventBody,
  type FakeBillingControls,
  type FakeBillingOptions,
  type FakeBillingProvider,
  type FakeDelivery,
} from "./provider";
export {
  emptyFakeBillingState,
  type FakeBillingState,
  type FakeBillingStore,
  type FakeEvent,
  type FakeStoreRedis,
  memoryFakeBillingStore,
  redisFakeBillingStore,
} from "./store";

/**
 * The fake's webhook secret, derived from a dev secret (BETTER_AUTH_SECRET in dev), so nothing new needs configuring and
 * no fixed value ships in the repository. Never used with the real processor.
 */
export const fakeWebhookSecret = (seed: string): string =>
  `whsec_dev_${createHmac("sha256", seed).update("anhourmail billing-fake webhook").digest("hex")}`;

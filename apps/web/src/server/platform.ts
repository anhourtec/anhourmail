// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { type Platform, platformFacts } from "@anhourmail/shared/platform";

import { env } from "./env";

/**
 * This deployment's public hostnames (mail, DNS targets, client settings), from `PLATFORM_DOMAIN`. Everything the
 * console and webmail show customers about hostnames comes from here, never from the product's published facts
 * (docs/internal/01-architecture.md "Platform hostnames").
 */
export function platform(): Platform {
  return platformFacts(env().PLATFORM_DOMAIN);
}

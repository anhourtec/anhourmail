// SPDX-License-Identifier: AGPL-3.0-only
/** Types for `dev-forwarded-for.mjs` (dev port forwarder; see that file). */
export function plainAddress(address: string | undefined): string;
export function forwardedFor(remoteAddress: string | undefined, sent: string | string[] | undefined): string;

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Request schemas shared by the marketing site (client-side hints) and the console API (enforcement).
 * The server always re-validates; client validation is a convenience only.
 */
import { z } from "zod";

export { KNOWN_SOURCES } from "./sources";

const utm = z.string().trim().max(100).optional();

export const UtmSchema = z.object({
  source: utm,
  medium: utm,
  campaign: utm,
  term: utm,
  content: utm,
});
export type Utm = z.infer<typeof UtmSchema>;

export const WaitlistSignupSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  /** "Which community did you come from?" — optional. */
  community: z.string().trim().max(80).optional(),
  /** Referral or invite code from a link, if any. */
  ref: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{4,32}$/)
    .optional(),
  utm: UtmSchema.optional(),
  /**
   * Honeypot: real people leave it empty. Accepted here on purpose — the service drops filled ones silently
   * (same response), so bots learn nothing from a validation error.
   */
  website: z.string().max(500).optional(),
  /** Client timestamp (ms) when the form was rendered; the server enforces a minimum fill time. */
  startedAt: z.number().int().positive(),
});
export type WaitlistSignup = z.infer<typeof WaitlistSignupSchema>;

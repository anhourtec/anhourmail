// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PROTOCOL: z.enum(["http", "https"]).default("http"),
  APP_URL: z.url(),
  WEBMAIL_URL: z.url(),
  SITE_URL: z.url(),
  WEB_DEV_PORT: z.coerce.number().int().default(43200),
  BETTER_AUTH_SECRET: z.string().min(32),
  // Closed unless explicitly opened (the maintainer opens it while the app is behind the IP allow-list).
  SIGNUP_MODE: z.enum(["open", "invite", "closed"]).default("closed"),
  MAIL_TRANSPORT_URL: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

/** Values from .env.example that must never reach production. */
const PLACEHOLDER_SECRETS = new Set(["dev-only-better-auth-secret-change-me-0123456789"]);

const checked = schema.superRefine((e, ctx) => {
  if (e.NODE_ENV !== "production") return;
  if (PLACEHOLDER_SECRETS.has(e.BETTER_AUTH_SECRET)) {
    ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_SECRET"], message: "Placeholder secret refused in production" });
  }
  // Behind NGINX every request carries the client address; without it all callers would share one rate-limit
  // bucket (security audit 2026-10-21).
  if (e.TRUST_PROXY !== "true") {
    ctx.addIssue({
      code: "custom",
      path: ["TRUST_PROXY"],
      message: "Production runs behind our proxy: set TRUST_PROXY=true",
    });
  }
  // Secure session cookies need an https origin.
  for (const key of ["APP_URL", "WEBMAIL_URL", "SITE_URL"] as const) {
    if (!e[key].startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: [key], message: "Production URLs must be https" });
    }
  }
});

export type Env = z.infer<typeof schema>;
let cached: Env | null = null;

/** Validated environment, read lazily so builds don't need runtime secrets. */
export function env(): Env {
  cached ??= checked.parse(process.env);
  return cached;
}

/** Tests only: forget the cached parse so stubbed variables apply. */
export function resetEnvForTests(): void {
  cached = null;
}

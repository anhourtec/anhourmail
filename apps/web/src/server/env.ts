// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { z } from "zod";

import { isPlatformDomain, parsePlatformDomain, productionPlatformProblems } from "@anhourmail/shared/platform";

import { stalwartSettingsProblems } from "./adapters/stalwart-settings";

/** An http(s) URL: these become links and origins, so no other scheme is accepted in any mode. */
const httpUrl = z.url({ protocol: /^https?$/ });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PROTOCOL: z.enum(["http", "https"]).default("http"),
  APP_URL: httpUrl,
  WEBMAIL_URL: httpUrl,
  SITE_URL: httpUrl,
  // The deployment's own domain: mail, DNS and client hostnames are built under it (`platform()`). Unset or blank =
  // anhourmail.com. A staging or self-hosted install sets its own so customers never see production names.
  PLATFORM_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim().toLowerCase())
    .refine((v) => v === "" || isPlatformDomain(v), {
      message: "Use a domain name like example.org (lowercase, no scheme, no trailing dot)",
    })
    .transform((v) => parsePlatformDomain(v)),
  WEB_DEV_PORT: z.coerce.number().int().default(43200),
  BETTER_AUTH_SECRET: z.string().min(32),
  // Closed unless explicitly opened (the maintainer opens it while the app is behind the IP allow-list).
  SIGNUP_MODE: z.enum(["open", "closed"]).default("closed"),
  MAIL_TRANSPORT_URL: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Stalwart's HTTP base (internal network in production): the webmail BFF's OAuth and JMAP upstream.
  STALWART_URL: httpUrl.optional(),
  // Secrets-at-rest key ring, "id:base64(32 bytes)[,…]" (first = active). Required in production; dev derives one.
  SECRETS_KEYRING: z.string().optional(),
  // Mailbox password grants (ADR-0020 "Mailbox passwords"): the HMAC key shared only with the management proxy, which
  // accepts the worker's replacement of an existing account's password only with a grant made here. Never in the
  // worker. Required in production (32+ characters); unset in dev (no proxy).
  MAILBOX_PASSWORD_GRANT_KEY: z.string().optional(),
});

/** Values from .env.example that must never reach production. */
const PLACEHOLDER_SECRETS = new Set(["dev-only-better-auth-secret-change-me-0123456789"]);

const checked = schema.superRefine((e, ctx) => {
  // Stalwart: only the operations key here; in production never the provisioning or audit key, nor the dev admin
  // (ADR-0020 "Credential split"). Read from the raw environment: these settings aren't part of `Env`.
  for (const message of stalwartSettingsProblems({ ...process.env, NODE_ENV: e.NODE_ENV })) {
    ctx.addIssue({ code: "custom", path: ["STALWART"], message });
  }
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
  if ((e.MAILBOX_PASSWORD_GRANT_KEY ?? "").trim().length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["MAILBOX_PASSWORD_GRANT_KEY"],
      message: "Set MAILBOX_PASSWORD_GRANT_KEY (32+ characters, shared only with the management proxy) in production",
    });
  }
  if (!e.SECRETS_KEYRING || e.SECRETS_KEYRING.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["SECRETS_KEYRING"], message: "Set the secrets key ring in production" });
  }
  // The console and webmail must sit directly under an explicitly set platform domain (app.<domain>, mail.<domain>):
  // a deployment on another domain that forgot PLATFORM_DOMAIN would otherwise tell customers production's mail hosts.
  for (const message of productionPlatformProblems({
    platformDomainSetting: process.env.PLATFORM_DOMAIN,
    domain: e.PLATFORM_DOMAIN,
    urls: { APP_URL: e.APP_URL, WEBMAIL_URL: e.WEBMAIL_URL },
  })) {
    ctx.addIssue({ code: "custom", path: ["PLATFORM_DOMAIN"], message });
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

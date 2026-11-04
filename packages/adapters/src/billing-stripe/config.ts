// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing configuration from the environment (ADR-0029 §3). Env only: no key, secret, price or product id is ever in the
 * repository, the database, logs or audit. Pure parsing; problems name settings, never values.
 */

export type BillingProviderKind = "off" | "fake" | "stripe";

export type StripeConfig = {
  secretKey: string;
  /** From the key: `live` keys charge real cards. */
  mode: "live" | "test";
  /** Several during a rotation: any one may verify. */
  webhookSecrets: string[];
  /** Each list: first = current (new checkouts and the catalogue check), the rest = legacy prices still mapped. */
  prices: { plus: string[]; storageBlock: string[]; extraMailbox: string[] };
  supporterProduct: string;
  portalConfiguration: string | null;
};

type Env = Record<string, string | undefined>;

const KINDS: readonly BillingProviderKind[] = ["off", "fake", "stripe"];
/** Provider ids go into URL paths and form bodies: letters, digits and underscores only. */
const ID = /^[A-Za-z0-9_]{3,255}$/;

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const set = (v: string | undefined): boolean => (v ?? "").trim() !== "";

/**
 * The provider in effect: `BILLING_PROVIDER` as set, else `off` in production (billing opens deliberately) and `fake`
 * everywhere else (dev, tests and CI never need a payment account).
 */
export function billingProviderKind(env: Env): BillingProviderKind {
  const v = (env.BILLING_PROVIDER ?? "").trim().toLowerCase();
  if ((KINDS as readonly string[]).includes(v)) return v as BillingProviderKind;
  return env.NODE_ENV === "production" ? "off" : "fake";
}

const keyMode = (key: string): "live" | "test" | null => {
  const m = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]+$/.exec(key);
  return m ? (m[1] as "live" | "test") : null;
};

/** Everything wrong with the billing settings, by name (start-up refuses when not empty). */
export function billingSettingsProblems(env: Env): string[] {
  const problems: string[] = [];
  const raw = (env.BILLING_PROVIDER ?? "").trim();
  if (raw !== "" && !(KINDS as readonly string[]).includes(raw.toLowerCase())) {
    problems.push("BILLING_PROVIDER must be off, fake or stripe");
    return problems;
  }
  const kind = billingProviderKind(env);
  const production = env.NODE_ENV === "production";
  if (kind === "fake" && production) {
    problems.push("BILLING_PROVIDER=fake is for development and tests only: use off or stripe in production");
  }
  if (kind !== "stripe") return problems;

  const key = (env.STRIPE_SECRET_KEY ?? "").trim();
  const mode = keyMode(key);
  if (key === "") problems.push("Set STRIPE_SECRET_KEY (a restricted key, rk_…) for BILLING_PROVIDER=stripe");
  else if (mode === null) problems.push("STRIPE_SECRET_KEY must be a secret or restricted key (sk_… or rk_…)");
  else if (production && mode === "test" && env.BILLING_ALLOW_TEST_KEYS !== "true") {
    problems.push(
      "STRIPE_SECRET_KEY is a test key in production: set BILLING_ALLOW_TEST_KEYS=true only for pre-staging",
    );
  } else if (!production && mode === "live") {
    problems.push("STRIPE_SECRET_KEY is a live key outside production: use a test key");
  }

  const secrets = list(env.STRIPE_WEBHOOK_SECRET);
  if (secrets.length === 0) problems.push("Set STRIPE_WEBHOOK_SECRET (comma-separated during a rotation)");
  else if (!secrets.every((s) => /^whsec_[A-Za-z0-9_]+$/.test(s))) {
    problems.push("STRIPE_WEBHOOK_SECRET must be webhook signing secrets (whsec_…)");
  }

  for (const name of ["STRIPE_PRICE_PLUS", "STRIPE_PRICE_STORAGE_BLOCK", "STRIPE_PRICE_EXTRA_MAILBOX"] as const) {
    const ids = list(env[name]);
    if (ids.length === 0) problems.push(`Set ${name} (price ids, first = current)`);
    else if (!ids.every((id) => id.startsWith("price_") && ID.test(id))) {
      problems.push(`${name} must be price ids (price_…)`);
    }
  }
  const product = (env.STRIPE_PRODUCT_SUPPORTER ?? "").trim();
  if (product === "") problems.push("Set STRIPE_PRODUCT_SUPPORTER (the Supporter product id)");
  else if (!product.startsWith("prod_") || !ID.test(product)) {
    problems.push("STRIPE_PRODUCT_SUPPORTER must be a product id (prod_…)");
  }
  const portal = (env.STRIPE_PORTAL_CONFIGURATION ?? "").trim();
  if (portal !== "" && (!portal.startsWith("bpc_") || !ID.test(portal))) {
    problems.push("STRIPE_PORTAL_CONFIGURATION must be a portal configuration id (bpc_…) or unset");
  }
  return problems;
}

/** The processor's settings; throws (naming settings only) unless `BILLING_PROVIDER=stripe` is fully configured. */
export function stripeConfig(env: Env): StripeConfig {
  const problems =
    billingProviderKind(env) === "stripe" ? billingSettingsProblems(env) : ["BILLING_PROVIDER is not stripe"];
  if (problems.length > 0) throw new Error(`Billing configuration refused: ${problems.join("; ")}`);
  const secretKey = (env.STRIPE_SECRET_KEY ?? "").trim();
  return {
    secretKey,
    mode: keyMode(secretKey) ?? "test",
    webhookSecrets: list(env.STRIPE_WEBHOOK_SECRET),
    prices: {
      plus: list(env.STRIPE_PRICE_PLUS),
      storageBlock: list(env.STRIPE_PRICE_STORAGE_BLOCK),
      extraMailbox: list(env.STRIPE_PRICE_EXTRA_MAILBOX),
    },
    supporterProduct: (env.STRIPE_PRODUCT_SUPPORTER ?? "").trim(),
    portalConfiguration: set(env.STRIPE_PORTAL_CONFIGURATION) ? (env.STRIPE_PORTAL_CONFIGURATION ?? "").trim() : null,
  };
}

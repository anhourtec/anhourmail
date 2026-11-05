// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Demo billing states (ADR-0029; CLAUDE.md rule 50), seeded with `--demo` through the dev fake provider exactly as the
 * console makes them: a real checkout on the fake, its signed events through ingestion, then `billing.sync`. So every
 * state is one the provider agrees with (the nightly reconcile and any later event keep it), and its audit entries are
 * the real ones. Three accounts whose mailboxes are on the deployment's platform domain (`PLATFORM_DOMAIN`, the free
 * addresses: what Free keeps after a lapse), each with an Owner who can sign in to the console and the webmail:
 *
 *   - Billing Plus: paying for Plus (active), with the fake portal and Billing page to try;
 *   - Billing Past due: Plus whose renewal failed (the card keeps failing): the "payment failed" banner;
 *   - Billing Lapsed: Plus that ended with two platform mailboxes: Free keeps the Owner's, the other is held.
 *
 * Only with `BILLING_PROVIDER=fake` (the dev default); otherwise it says so and seeds nothing. Idempotent: an account
 * whose fake customer still exists is left as it is; one whose fake state is gone (a Redis flush) is seeded again.
 * Never touches the other demo accounts or the fake's shared clock.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { hashPassword } from "@anhourmail/adapters/auth";
import { billingRedirectOrigins, createBillingProvider, isFakeBillingProvider } from "@anhourmail/adapters/billing";
import type { FakeBillingProvider } from "@anhourmail/adapters/billing";
import { type Db, schema } from "@anhourmail/adapters/postgres";
import type { Actor, Deps } from "@anhourmail/core";
import { type BillingContext, ingestBillingEvent, startCheckout, syncAccountBilling } from "@anhourmail/core/billing";
import { redis } from "@anhourmail/server/redis";
import type { StalwartManagement } from "@anhourmail/stalwart-client";

import type { CredentialRow } from "./credentials";

type Demo = {
  name: string;
  state: "active" | "past_due" | "lapsed";
  owner: { local: string; name: string };
  /** A second platform mailbox with nobody behind it (held after the lapse). */
  extraMailbox?: string;
  tryThis: string;
};

const DEMOS: readonly Demo[] = [
  {
    name: "Billing Plus",
    state: "active",
    owner: { local: "billing-plus", name: "Billing Plus Owner" },
    tryThis: "Pays for Plus through the dev fake: Billing page, add-ons with preview, cancel, the fake portal",
  },
  {
    name: "Billing Past due",
    state: "past_due",
    owner: { local: "billing-pastdue", name: "Billing Past Due Owner" },
    tryThis: "Plus whose renewal failed (the card keeps failing): the payment banner; fix it in the fake portal",
  },
  {
    name: "Billing Lapsed",
    state: "lapsed",
    owner: { local: "billing-lapsed", name: "Billing Lapsed Owner" },
    extraMailbox: "billing-lapsed-extra",
    tryThis:
      "Plus ended: Free keeps this mailbox, the other one is held (Billing → Choose what stays on, subscribe again)",
  },
];

const MAILBOX_QUOTA = 512 * 1024 * 1024;
const REQ = { requestId: "seed-billing", ip: null, userAgent: null };

export type BillingSeedContext = {
  db: Db;
  deps: Deps;
  mgmt: StalwartManagement;
  newPassword: () => string;
  appUrl: string;
  log: (msg: string) => void;
};

export async function seedBillingDemo(
  ctx: BillingSeedContext,
): Promise<{ rows: CredentialRow[]; special: { label: string; detail: string }[] }> {
  const provider = createBillingProvider({
    env: process.env,
    appUrl: ctx.appUrl,
    fakeSeed: process.env.BETTER_AUTH_SECRET ?? "",
    redis,
  });
  if (!isFakeBillingProvider(provider)) {
    ctx.log("billing demo: skipped (BILLING_PROVIDER isn't fake)");
    return {
      rows: [],
      special: [
        { label: "Billing demo states", detail: "not seeded: they need `BILLING_PROVIDER=fake` (the default)" },
      ],
    };
  }
  const billing: BillingContext = {
    provider,
    appUrl: ctx.appUrl,
    redirectOrigins: billingRedirectOrigins(provider, ctx.appUrl),
    paidPlansOpen: true,
  };
  const rows: CredentialRow[] = [];
  const special: { label: string; detail: string }[] = [];
  const domain = ctx.deps.platform.domain;
  try {
    for (const demo of DEMOS) {
      const email = `${demo.owner.local}@${domain}`;
      const password = ctx.newPassword();
      const accountId = await upsertAccount(ctx.db, demo.name);
      const userId = await upsertOwner(ctx.db, accountId, email, demo.owner.name, password);
      await upsertMailbox(ctx, accountId, email, userId, password, demo.owner.name);
      if (demo.extraMailbox) {
        await upsertMailbox(ctx, accountId, `${demo.extraMailbox}@${domain}`, null, ctx.newPassword(), null);
      }
      const state = await ensureState(ctx, provider, billing, demo, accountId, { userId, email });
      ctx.log(`billing demo: ${demo.name} ${state}`);
      rows.push({ group: "Customer: Billing demos", role: "owner", email, password, tryThis: demo.tryThis });
    }
  } finally {
    await redis().quit();
  }
  special.push(
    {
      label: "Billing: paying",
      detail: `\`billing-plus@${domain}\` pays for Plus through the dev fake (Billing page; the fake portal from "Manage payment and invoices")`,
    },
    {
      label: "Billing: past due",
      detail: `\`billing-pastdue@${domain}\`: the renewal failed and the card keeps failing — the payment banner; "Card works" then "Pay the open invoice" in the fake portal recovers it`,
    },
    {
      label: "Billing: lapsed with holds",
      detail: `\`billing-lapsed@${domain}\`: Plus ended; Free keeps the Owner's mailbox and \`billing-lapsed-extra@${domain}\` is held (Billing → Choose what stays on)`,
    },
  );
  return { rows, special };
}

/** Drives the account to the demo's state through the fake, unless its fake customer is still there. */
async function ensureState(
  ctx: BillingSeedContext,
  provider: FakeBillingProvider,
  billing: BillingContext,
  demo: Demo,
  accountId: string,
  owner: { userId: string; email: string },
): Promise<string> {
  const current = await ctx.deps.uow.run((r) => r.billing.get(accountId));
  if (current?.providerCustomerId && (await provider.describe("customer", current.providerCustomerId))) {
    return `kept (${current.state})`;
  }
  // A fresh start (a new account, or the fake's state is gone): Free, nothing held, nothing disputed.
  await ctx.db.delete(schema.planHold).where(eq(schema.planHold.accountId, accountId));
  await ctx.db.delete(schema.billingDispute).where(eq(schema.billingDispute.accountId, accountId));
  await ctx.db.delete(schema.accountBilling).where(eq(schema.accountBilling.accountId, accountId));
  await ctx.db.update(schema.customerAccount).set({ plan: "free" }).where(eq(schema.customerAccount.id, accountId));

  const actor: Actor = {
    kind: "user",
    userId: owner.userId,
    email: owner.email,
    platformRoles: [],
    memberships: [{ accountId, role: "owner" }],
    suspended: false,
  };
  const { url } = await startCheckout(ctx.deps, billing, actor, accountId, { plan: "plus", currency: "USD" }, REQ);
  await provider.completeCheckout(url.split("/").pop() ?? "", "pay");
  await deliverAndSync(ctx.deps, provider, accountId);
  const customerId = (await ctx.deps.uow.run((r) => r.billing.get(accountId)))?.providerCustomerId ?? "";
  if (demo.state === "past_due") {
    await provider.setCardFails(customerId, true);
    await provider.renewNow(customerId);
    await deliverAndSync(ctx.deps, provider, accountId);
  } else if (demo.state === "lapsed") {
    const subscriptionId = (await provider.describe("customer", customerId))?.subscription?.id ?? "";
    await provider.cancel({ subscriptionId, when: "now", intentId: `seed-lapse:${accountId}` });
    await deliverAndSync(ctx.deps, provider, accountId);
  }
  const after = await ctx.deps.uow.run((r) => r.billing.get(accountId));
  if (after?.state !== demo.state)
    throw new Error(`billing demo ${demo.name} ended ${after?.state ?? "without a row"}`);
  return after.state;
}

/** The fake's signed events through the real verification and ingestion, then the account's sync (as the worker). */
async function deliverAndSync(deps: Deps, provider: FakeBillingProvider, accountId: string): Promise<void> {
  for (const d of await provider.drainDeliveries()) {
    const now = new Date();
    await ingestBillingEvent(deps, provider.verifyWebhook(d.body, d.signature, now), now);
  }
  await syncAccountBilling(deps, provider, accountId, { requestId: "seed-billing-sync" });
}

async function upsertAccount(db: Db, name: string): Promise<string> {
  const [existing] = await db.select().from(schema.customerAccount).where(eq(schema.customerAccount.name, name));
  if (existing) return existing.id;
  const [row] = await db.insert(schema.customerAccount).values({ name, plan: "free" }).returning();
  if (!row) throw new Error(`account ${name} not created`);
  return row.id;
}

async function upsertOwner(db: Db, accountId: string, email: string, name: string, password: string): Promise<string> {
  const hash = await hashPassword(password);
  const [existing] = await db.select().from(schema.authUser).where(eq(schema.authUser.email, email));
  const userId = existing?.id ?? randomUUID();
  if (!existing) {
    await db.insert(schema.authUser).values({ id: userId, name, email, emailVerified: true });
    await db
      .insert(schema.authAccount)
      .values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: hash });
  } else {
    await db
      .update(schema.authAccount)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(schema.authAccount.userId, userId), eq(schema.authAccount.providerId, "credential")));
  }
  await db.insert(schema.userProfile).values({ userId, state: "paid" }).onConflictDoNothing();
  await db
    .insert(schema.accountMembership)
    .values({ accountId, userId, role: "owner" })
    .onConflictDoUpdate({
      target: [schema.accountMembership.accountId, schema.accountMembership.userId],
      set: { role: "owner" },
    });
  return userId;
}

/** A platform-domain mailbox on the dev mail server and in the control plane (sign-in with the Owner's password). */
async function upsertMailbox(
  ctx: BillingSeedContext,
  accountId: string,
  address: string,
  userId: string | null,
  password: string,
  senderName: string | null,
): Promise<void> {
  const [name = address, domain = ctx.deps.platform.domain] = address.split("@");
  const stalwartId = await ctx.mgmt.upsertUser({
    name,
    domain,
    password: await hashPassword(password),
    resetPassword: true,
    quotaBytes: MAILBOX_QUOTA,
    suspended: false,
    description: senderName,
    aliases: [],
  });
  const passwordCredentialId = await ctx.mgmt.passwordCredentialId(stalwartId);
  await ctx.db
    .insert(schema.mailbox)
    .values({ accountId, userId, address, stalwartId, quotaBytes: MAILBOX_QUOTA, passwordCredentialId })
    .onConflictDoUpdate({
      target: schema.mailbox.address,
      set: { stalwartId, accountId, userId, passwordCredentialId, pendingPasswordHash: null },
    });
}

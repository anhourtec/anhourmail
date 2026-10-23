// SPDX-License-Identifier: AGPL-3.0-only
import { mutation } from "../mutation";
import type { Deps } from "../ports";

/**
 * The mail server's service accounts (the owners of the management keys, `svc-*`; ADR-0020 "Credential split") on the
 * deployment's infrastructure domains, with the kinds of credential each holds (adapter: `x:Account.credentials` with
 * the provisioning key). Never secrets. `domains` is which domains were searched (empty = none configured, a
 * misconfiguration the check must not pass silently).
 */
export type ServiceAccountInventory = {
  list(): Promise<{ accounts: { name: string; credentials: string[] }[]; domains: string[] }>;
};

export type ServiceAccountDrift = {
  checked: number;
  /** The expected accounts not found on any infrastructure domain (svc-provision / svc-ops / svc-audit). */
  missing: string[];
  /**
   * A password on a service account: any key that can update accounts can set one, and a password sign-in gets the
   * account's role — for the operations or audit account that is `impersonate`, including the `<mailbox>%<account>`
   * sign-in as any mailbox, even on the mail ports (verified). Only the deployment's bootstrap ever writes these
   * accounts, and the management proxy refuses a credentials write, so this should never appear.
   */
  withPassword: number;
  /** An app password (the operations key can mint one on its own account; the proxy refuses it on a service account). */
  withAppPassword: number;
  /** No API key left (the process using it would stop working). */
  withoutKey: number;
  /** No infrastructure domain was configured, so nothing could be checked (production refuses this). */
  misconfigured: boolean;
  clean: boolean;
};

const RECONCILER = { kind: "system", name: "reconcile" } as const;

/**
 * Reconciler: every expected service account must exist and hold API keys only. A missing account, a password, an app
 * password or a lost key is reported and audited as `platform.reconciler_drift` (counts and names only) for a person
 * to look at — never removed (CLAUDE.md rule 26): removing credentials could cut a running process off. `expected` is
 * the account local parts that must be present (`svc-provision`, `svc-ops`, `svc-audit`); when no infrastructure
 * domain is configured the check reports `misconfigured` rather than passing with `checked: 0`.
 */
export async function reconcileServiceAccounts(
  deps: Deps,
  inventory: ServiceAccountInventory,
  expected: readonly string[],
): Promise<ServiceAccountDrift> {
  const { accounts, domains } = await inventory.list();
  const present = new Set(accounts.map((a) => a.name));
  const out: ServiceAccountDrift = {
    checked: accounts.length,
    missing: expected.filter((n) => !present.has(n)),
    withPassword: accounts.filter((a) => a.credentials.includes("Password")).length,
    withAppPassword: accounts.filter((a) => a.credentials.includes("AppPassword")).length,
    withoutKey: accounts.filter((a) => !a.credentials.includes("ApiKey")).length,
    misconfigured: domains.length === 0,
    clean: true,
  };
  out.clean = !out.misconfigured && out.missing.length + out.withPassword + out.withAppPassword + out.withoutKey === 0;
  if (!out.clean) {
    const now = deps.clock.now();
    await mutation(
      deps,
      RECONCILER,
      { requestId: `reconcile-service-accounts-${String(now.getTime())}`, ip: null, userAgent: null },
      {
        action: "platform.reconciler_drift",
        permission: "self.profile.read",
        accountId: null,
        target: { type: "mail_server", label: "service accounts" },
      },
      async () => ({
        result: undefined,
        meta: {
          serviceAccountsChecked: out.checked,
          serviceAccountsMissing: out.missing, // account local parts only, no secrets
          serviceAccountsWithPassword: out.withPassword,
          serviceAccountsWithAppPassword: out.withAppPassword,
          serviceAccountsWithoutKey: out.withoutKey,
          serviceAccountDomainsConfigured: domains.length,
        },
      }),
    );
  }
  return out;
}

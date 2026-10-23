// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests only: the three service accounts and their real, exactly-scoped keys (`@anhourmail/stalwart-client`
 * `SERVICE_CREDENTIALS`) on a throwaway domain of the dev server, so tests run the code under test with the
 * credentials production uses rather than the dev admin. Keys have no IP allow-list and expire after a day; `cleanup`
 * destroys the accounts (and their keys), the domain and the roles.
 */
import {
  CREDENTIAL_ROLES,
  ensureServiceAccount,
  issueServiceKey,
  serviceRoleDescription,
  StalwartManagement,
  type StalwartCredentialRole,
  StalwartTransport,
} from "@anhourmail/stalwart-client";

export type TestKeys = Record<StalwartCredentialRole, StalwartManagement> & {
  secrets: Record<StalwartCredentialRole, string>;
  accountIds: Record<StalwartCredentialRole, string>;
  domainId: string;
  cleanup(): Promise<void>;
};

export async function issueTestKeys(admin: StalwartManagement, baseUrl: string, domain: string): Promise<TestKeys> {
  const domainId = await admin.upsertDomain({ name: domain });
  const secrets = {} as Record<StalwartCredentialRole, string>;
  const accountIds = {} as Record<StalwartCredentialRole, string>;
  const clients = {} as Record<StalwartCredentialRole, StalwartManagement>;
  for (const role of CREDENTIAL_ROLES) {
    const { id } = await ensureServiceAccount(admin, role, domainId);
    accountIds[role] = id;
    secrets[role] = await issueServiceKey(admin, role, id, {
      description: "integration test",
      allowedIps: [],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    clients[role] = new StalwartManagement(
      new StalwartTransport({ baseUrl, auth: { type: "bearer", token: secrets[role] } }),
    );
  }
  return {
    ...clients,
    secrets,
    accountIds,
    domainId,
    async cleanup() {
      for (const role of CREDENTIAL_ROLES) await admin.destroy("x:Account", accountIds[role]).catch(() => undefined);
      const left = (await admin.listUsers()).filter((u) => u.address.endsWith(`@${domain}`));
      for (const u of left) await admin.destroy("x:Account", u.id);
      await admin.destroyDomain(domainId).catch(() => undefined);
      const roles = await admin.transport.getAll<{ id: string; description?: string }>("x:Role", ["description"]);
      const ours = new Set(CREDENTIAL_ROLES.map(serviceRoleDescription));
      const ids = roles.filter((r) => ours.has(r.description ?? "")).map((r) => r.id);
      if (ids.length > 0) await admin.transport.set("x:Role", { destroy: ids }).catch(() => undefined);
    },
  };
}

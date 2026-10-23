// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps as makeDeps, fixedClock } from "../__tests__/helpers";
import { reconcileServiceAccounts } from "./service-accounts";

const setup = () => makeDeps(fixedClock("2026-10-23T00:00:00Z"));
const EXPECTED = ["svc-provision", "svc-ops", "svc-audit"];

describe("reconcileServiceAccounts", () => {
  it("is clean, without an audit entry, when every expected account exists holding API keys only", async () => {
    const d = setup();
    const before = d.uow.state.audit.length;
    const report = await reconcileServiceAccounts(
      d,
      {
        list: async () => ({
          domains: ["sys.test"],
          accounts: [
            { name: "svc-provision", credentials: ["ApiKey"] },
            { name: "svc-ops", credentials: ["ApiKey", "ApiKey"] },
            { name: "svc-audit", credentials: ["ApiKey"] },
          ],
        }),
      },
      EXPECTED,
    );
    expect(report).toEqual({
      checked: 3,
      missing: [],
      withPassword: 0,
      withAppPassword: 0,
      withoutKey: 0,
      misconfigured: false,
      clean: true,
    });
    expect(d.uow.state.audit.length).toBe(before);
  });

  it("reports a missing account, passwords, app passwords and lost keys; audits names/counts only; removes nothing", async () => {
    const d = setup();
    const accounts = [
      { name: "svc-ops", credentials: ["ApiKey", "Password"] },
      { name: "svc-audit", credentials: ["AppPassword"] },
    ];
    const report = await reconcileServiceAccounts(
      d,
      { list: async () => ({ domains: ["sys.test"], accounts }) },
      EXPECTED,
    );
    expect(report).toMatchObject({
      checked: 2,
      missing: ["svc-provision"],
      withPassword: 1,
      withAppPassword: 1,
      withoutKey: 1,
      misconfigured: false,
      clean: false,
    });
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.reconciler_drift",
      target: { type: "mail_server", label: "service accounts" },
      meta: {
        serviceAccountsChecked: 2,
        serviceAccountsMissing: ["svc-provision"],
        serviceAccountsWithPassword: 1,
        serviceAccountsWithAppPassword: 1,
        serviceAccountsWithoutKey: 1,
        serviceAccountDomainsConfigured: 1,
      },
    });
    expect(accounts[0]?.credentials).toEqual(["ApiKey", "Password"]);
  });

  it("refuses to pass silently when no infrastructure domain is configured (checked: 0)", async () => {
    const d = setup();
    const report = await reconcileServiceAccounts(d, { list: async () => ({ domains: [], accounts: [] }) }, EXPECTED);
    expect(report.misconfigured).toBe(true);
    expect(report.clean).toBe(false);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.reconciler_drift",
      meta: { serviceAccountDomainsConfigured: 0, serviceAccountsMissing: EXPECTED },
    });
  });
});

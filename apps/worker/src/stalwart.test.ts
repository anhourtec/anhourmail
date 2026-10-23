// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkStalwartSettings, WORKER_CREDENTIALS } from "./stalwart";

const prod = { NODE_ENV: "production" };

describe("worker Stalwart settings (ADR-0020 credential split)", () => {
  it("never lists the operations key for any worker-image process", () => {
    for (const { required, optional } of Object.values(WORKER_CREDENTIALS)) {
      expect([...required, ...optional]).not.toContain("operations");
    }
  });

  it("runs the queue worker with the provisioning key only", () => {
    expect(() => {
      checkStalwartSettings("worker", { ...prod, STALWART_PROVISIONING_KEY: "p" });
    }).not.toThrow();
    expect(() => {
      checkStalwartSettings("worker", prod);
    }).toThrow(/STALWART_PROVISIONING_KEY must be set in production/);
    expect(() => {
      checkStalwartSettings("worker", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_OPERATIONS_KEY: "o" });
    }).toThrow(/STALWART_OPERATIONS_KEY must not be given to this process/);
    // The audit key belongs to the scheduler, not the queue worker.
    expect(() => {
      checkStalwartSettings("worker", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_AUDIT_KEY: "a" });
    }).toThrow(/STALWART_AUDIT_KEY must not be given to this process/);
    // Never the web app's mailbox password grant key, in any environment.
    expect(() => {
      checkStalwartSettings("worker", { STALWART_PROVISIONING_KEY: "p", MAILBOX_PASSWORD_GRANT_KEY: "g".repeat(40) });
    }).toThrow(/MAILBOX_PASSWORD_GRANT_KEY must not be given/);
    expect(() => {
      checkStalwartSettings("scheduler", { STALWART_PROVISIONING_KEY: "p", MAILBOX_PASSWORD_GRANT_KEY: "g" });
    }).toThrow(/MAILBOX_PASSWORD_GRANT_KEY must not be given/);
  });

  it("requires the audit key on the scheduler and allows it on one-off jobs", () => {
    expect(() => {
      checkStalwartSettings("scheduler", { ...prod, STALWART_PROVISIONING_KEY: "p" });
    }).toThrow(/STALWART_AUDIT_KEY must be set in production/);
    const both = { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_AUDIT_KEY: "a" };
    expect(() => {
      checkStalwartSettings("scheduler", both);
    }).not.toThrow();
    expect(() => {
      checkStalwartSettings("job", both);
    }).not.toThrow();
    expect(() => {
      checkStalwartSettings("job", { ...prod, STALWART_PROVISIONING_KEY: "p" });
    }).not.toThrow();
  });

  it("refuses the dev admin in production and the legacy key anywhere", () => {
    expect(() => {
      checkStalwartSettings("job", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_DEV_ADMIN_PASSWORD: "x" });
    }).toThrow(/STALWART_DEV_ADMIN_PASSWORD is for development only/);
    expect(() => {
      checkStalwartSettings("worker", { STALWART_API_KEY: "old" });
    }).toThrow(/STALWART_API_KEY is no longer/);
    expect(() => {
      checkStalwartSettings("worker", { STALWART_DEV_ADMIN_USER: "admin" });
    }).not.toThrow();
  });
});

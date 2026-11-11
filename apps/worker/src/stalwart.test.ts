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

  it("runs the queue worker with the provisioning, training and hold keys only", () => {
    const keys = { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_TRAINING_KEY: "t", STALWART_HOLD_KEY: "h" };
    expect(() => {
      checkStalwartSettings("worker", keys);
    }).not.toThrow();
    expect(() => {
      checkStalwartSettings("worker", prod);
    }).toThrow(/STALWART_PROVISIONING_KEY must be set in production/);
    expect(() => {
      checkStalwartSettings("worker", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_HOLD_KEY: "h" });
    }).toThrow(/STALWART_TRAINING_KEY must be set in production/);
    // The relay hold's list (ADR-0034): `mailbox.ensure` can't apply a held mailbox without it.
    expect(() => {
      checkStalwartSettings("worker", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_TRAINING_KEY: "t" });
    }).toThrow(/STALWART_HOLD_KEY must be set in production/);
    expect(() => {
      checkStalwartSettings("worker", { ...keys, STALWART_OPERATIONS_KEY: "o" });
    }).toThrow(/STALWART_OPERATIONS_KEY must not be given to this process/);
    // The audit key belongs to the scheduler, not the queue worker.
    expect(() => {
      checkStalwartSettings("worker", { ...keys, STALWART_AUDIT_KEY: "a" });
    }).toThrow(/STALWART_AUDIT_KEY must not be given to this process/);
    // The training key belongs to the queue worker only.
    expect(() => {
      checkStalwartSettings("scheduler", {
        ...prod,
        STALWART_PROVISIONING_KEY: "p",
        STALWART_AUDIT_KEY: "a",
        STALWART_HOLD_KEY: "h",
        STALWART_TRAINING_KEY: "t",
      });
    }).toThrow(/STALWART_TRAINING_KEY must not be given to this process/);
    // Never the web app's mailbox password grant key, in any environment.
    expect(() => {
      checkStalwartSettings("worker", { STALWART_PROVISIONING_KEY: "p", MAILBOX_PASSWORD_GRANT_KEY: "g".repeat(40) });
    }).toThrow(/MAILBOX_PASSWORD_GRANT_KEY must not be given/);
    expect(() => {
      checkStalwartSettings("scheduler", { STALWART_PROVISIONING_KEY: "p", MAILBOX_PASSWORD_GRANT_KEY: "g" });
    }).toThrow(/MAILBOX_PASSWORD_GRANT_KEY must not be given/);
    // Nor the send-on-behalf key (web app and mail server only).
    expect(() => {
      checkStalwartSettings("worker", { STALWART_PROVISIONING_KEY: "p", SENDER_DELEGATION_KEY: "d".repeat(64) });
    }).toThrow(/SENDER_DELEGATION_KEY must not be given/);
  });

  it("requires the audit and hold keys on the scheduler and allows them on one-off jobs", () => {
    expect(() => {
      checkStalwartSettings("scheduler", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_HOLD_KEY: "h" });
    }).toThrow(/STALWART_AUDIT_KEY must be set in production/);
    expect(() => {
      checkStalwartSettings("scheduler", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_AUDIT_KEY: "a" });
    }).toThrow(/STALWART_HOLD_KEY must be set in production/);
    const both = { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_AUDIT_KEY: "a", STALWART_HOLD_KEY: "h" };
    expect(() => {
      checkStalwartSettings("scheduler", both);
    }).not.toThrow();
    expect(() => {
      checkStalwartSettings("job", both);
    }).not.toThrow();
    expect(() => {
      checkStalwartSettings("job", { ...prod, STALWART_PROVISIONING_KEY: "p" });
    }).not.toThrow();
    // A one-off job started in the worker container inherits the training key.
    expect(() => {
      checkStalwartSettings("job", { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_TRAINING_KEY: "t" });
    }).not.toThrow();
  });

  it("gives the mail importer no Stalwart key at all", () => {
    expect(() => {
      checkStalwartSettings("importer", prod);
    }).not.toThrow();
    for (const k of [
      "STALWART_PROVISIONING_KEY",
      "STALWART_OPERATIONS_KEY",
      "STALWART_AUDIT_KEY",
      "STALWART_TRAINING_KEY",
      "STALWART_HOLD_KEY",
    ]) {
      expect(() => {
        checkStalwartSettings("importer", { ...prod, [k]: "k" });
      }).toThrow(new RegExp(`${k} must not be given to this process`));
    }
    expect(() => {
      checkStalwartSettings("importer", { ...prod, STALWART_DEV_ADMIN_USER: "admin" });
    }).toThrow(/for development only/);
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

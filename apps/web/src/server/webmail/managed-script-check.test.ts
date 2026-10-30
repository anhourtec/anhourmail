// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { inspectManagedScript } from "@anhourmail/core/webmail";

import { buildScript, DEFAULT_RULES } from "./sieve";

const ctx = {
  identities: ["me@family.test"],
  contacts: ["friend@example.test"],
  authservIds: ["mx1.family.test"],
  mailboxDomain: "family.test",
};

describe("the reconciler's view of the scripts the webmail writes", () => {
  it("sees our settings and no redirect when forwarding is off, whatever the auto-reply says", () => {
    const script = buildScript(
      {
        ...DEFAULT_RULES,
        vacation: {
          enabled: true,
          from: null,
          to: null,
          subject: 'Away "redirect" notify',
          message: 'Please redirect "boss@example.test"; require ["enotify"];',
          contactsOnly: true,
        },
        junk: { blocked: ["spam.example"], safe: [], trustedOnly: true },
      },
      ctx,
    );
    expect(inspectManagedScript(script)).toEqual({
      ours: true,
      forwarding: { enabled: false, address: null },
      redirects: [],
      foreign: [],
      unguardedRedirect: false,
    });
  });

  it("reads a confirmed forwarding target from both the settings line and the redirect", () => {
    const script = buildScript(
      { ...DEFAULT_RULES, forwarding: { enabled: true, address: "copy@example.test", keepCopy: true } },
      ctx,
    );
    expect(inspectManagedScript(script)).toMatchObject({
      ours: true,
      forwarding: { enabled: true, address: "copy@example.test" },
      redirects: ["copy@example.test"],
      foreign: [],
      // Today's generator checks our results for a DMARC failure; one written without ids doesn't.
      unguardedRedirect: false,
    });
    const older = buildScript(
      { ...DEFAULT_RULES, forwarding: { enabled: true, address: "copy@example.test", keepCopy: true } },
      { ...ctx, authservIds: [] },
    );
    expect(inspectManagedScript(older).unguardedRedirect).toBe(true);
  });

  it("flags a script that isn't ours, extra redirects, and extensions the webmail never writes", () => {
    expect(inspectManagedScript('redirect "x@evil.test";')).toMatchObject({ ours: false, redirects: ["x@evil.test"] });
    const ours = buildScript(DEFAULT_RULES, ctx);
    const tampered = `${ours}\nredirect :copy "spy@evil.test";\n`;
    expect(inspectManagedScript(tampered).redirects).toEqual(["spy@evil.test"]);
    const variables = 'require ["variables", "enotify"];\nif header :matches "X" "*" { redirect "${1}"; }\n';
    expect(inspectManagedScript(variables).foreign).toEqual(expect.arrayContaining(["variables", "enotify"]));
    expect(inspectManagedScript('require "fileinto";\nredirect ["a@x.test", "b@x.test"];').foreign).toContain(
      "redirect-expression",
    );
  });
});

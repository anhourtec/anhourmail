// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  buildScript,
  DEFAULT_RULES,
  dmarcPassRegex,
  forwardingGuard,
  upgradeManagedScript,
  fitContacts,
  includable,
  JunkInput,
  MAX_CONTACT_ADDRESSES,
  type MailRules,
  parseScript,
  senderEntry,
  sieveString,
  usesContacts,
  VacationInput,
  zoneOffset,
} from "./sieve";

const ctx = {
  identities: ["sam@a.test", "hi@a.test"],
  contacts: [] as string[],
  authservIds: ["mail.a.test"],
  mailboxDomain: "a.test",
};
const rules = (patch: Partial<MailRules>): MailRules => ({ ...DEFAULT_RULES, ...patch });

/** The script without its comment lines (the stored settings line carries every value base64-encoded). */
const code = (script: string) =>
  script
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n");

/** The script with every quoted string blanked: what's left is the commands and tests the server will run. */
const outsideStrings = (script: string) => code(script).replace(/"(?:\\.|[^"\\])*"/g, '""');

describe("Sieve quoting", () => {
  it("escapes backslashes and quotes, drops control characters, keeps line breaks", () => {
    expect(sieveString('say "hi"')).toBe('"say \\"hi\\""');
    expect(sieveString("a\\b")).toBe('"a\\\\b"');
    expect(sieveString("one\r\ntwo\rthree")).toBe('"one\ntwo\nthree"');
    expect(sieveString("bell\u0007nul\u0000tab\t")).toBe('"bellnultab"');
  });

  it("can't break out of a string: a crafted reply stays one string in the script", () => {
    const evil = 'Away";\r\nredirect "attacker@evil.example";\r\nkeep;\r\nvacation "';
    const script = buildScript(
      rules({
        vacation: { enabled: true, from: null, to: null, subject: evil, message: evil, contactsOnly: false },
      }),
      ctx,
    );
    const body = code(script);
    // No command was introduced: outside the (escaped) strings the only action is the one vacation call (inside the
    // spam/bulk guard), never a redirect/keep/discard/fileinto from the crafted text.
    const bare = outsideStrings(script);
    expect(bare).toContain('vacation :days 3 :subject "" :addresses ["", ""] "";');
    expect(bare).not.toMatch(/redirect|discard|fileinto/);
    expect(bare).not.toMatch(/^\s*keep;/m);
    // The subject has no line breaks at all; the message keeps them as text inside its string.
    expect(body).toContain(':subject "Away\\"; redirect \\"attacker@evil.example\\"; keep; vacation \\""');
    // Variables aren't enabled, so "${…}" is literal text, never expanded.
    const vars = buildScript(
      rules({
        vacation: {
          enabled: true,
          from: null,
          to: null,
          subject: "${from}",
          message: "${hex:22}",
          contactsOnly: false,
        },
      }),
      ctx,
    );
    expect(vars).not.toMatch(/"variables"|"encoded-character"/);
    expect(code(vars)).toContain('"${hex:22}"');
  });

  it("only accepts addresses and domains in sender lists (no quotes, spaces or Sieve syntax)", () => {
    expect(senderEntry(" Bob@Example.COM ")).toBe("bob@example.com");
    expect(senderEntry("@Spam.Example")).toBe("spam.example");
    expect(senderEntry("spam.example")).toBe("spam.example");
    for (const bad of ['a"@b.c', "x@y", "evil.example; stop", "a b@c.d", "", "@", "-x.y", 'test"]; redirect "x@y.z']) {
      expect(senderEntry(bad)).toBeNull();
    }
    expect(JunkInput.safeParse({ blocked: ['"]; keep;'], safe: [], trustedOnly: false }).success).toBe(false);
    const ok = JunkInput.parse({ blocked: ["a@b.co", "A@B.co", "@b.co"], safe: [], trustedOnly: false });
    expect(ok.blocked).toEqual(["a@b.co", "b.co"]);
    expect(includable("my filters")).toBe(true);
    expect(includable("anhourmail")).toBe(false);
    expect(includable('x"; keep; #')).toBe(false);
  });

  it("validates automatic replies: dates in order, a message when on, single-line subject", () => {
    expect(
      VacationInput.safeParse({
        enabled: true,
        from: "2026-11-02",
        to: "2026-11-01",
        subject: "",
        message: "x",
        contactsOnly: false,
      }).success,
    ).toBe(false);
    expect(
      VacationInput.safeParse({ enabled: true, from: null, to: null, subject: "", message: " ", contactsOnly: false })
        .success,
    ).toBe(false);
    const v = VacationInput.parse({
      enabled: true,
      from: null,
      to: null,
      subject: "Out\r\nBcc: x@y.z",
      message: "Back soon\r\n-- Sam",
      contactsOnly: false,
    });
    expect(v.subject).toBe("Out Bcc: x@y.z");
    expect(v.message).toBe("Back soon\n-- Sam");
  });
});

describe("the managed script", () => {
  it("is a no-op with nothing on, and round-trips its settings", () => {
    const script = buildScript(DEFAULT_RULES, ctx);
    expect(code(script).trim()).toBe('require ["fileinto", "special-use", "mailbox"];');
    expect(parseScript(script)).toEqual(DEFAULT_RULES);
    expect(parseScript("require [];\nkeep;\n")).toBeNull();
    expect(parseScript("# am-settings: not-json\n")).toBeNull();
  });

  it("files blocked senders in Junk and stops before replies and forwarding", () => {
    const script = buildScript(
      rules({
        junk: { blocked: ["bob@blocked.example", "spam.example"], safe: ["ok.example"], trustedOnly: false },
        vacation: {
          enabled: true,
          from: null,
          to: null,
          subject: "Away",
          message: "Back Monday.",
          contactsOnly: false,
        },
        forwarding: { enabled: true, address: "copy@example.org", keepCopy: true },
      }),
      ctx,
    );
    const body = code(script);
    expect(body).toContain('if address :domain :comparator "i;unicode-casemap" :is "from" ["ok.example"] {');
    expect(body).toContain(
      'elsif anyof (address :all :comparator "i;unicode-casemap" :is "from" ["bob@blocked.example"], address :domain :comparator "i;unicode-casemap" :is "from" ["spam.example"]) {\n  fileinto :specialuse "\\\\Junk" "Junk";\n  stop;\n}',
    );
    expect(body).toContain('vacation :days 3 :subject "Away" :addresses ["sam@a.test", "hi@a.test"] "Back Monday.";');
    expect(body).toContain('redirect :copy "copy@example.org";');
    expect(body.indexOf("stop;")).toBeLessThan(body.indexOf("vacation :days"));
    expect(body.indexOf("vacation :days")).toBeLessThan(body.indexOf("redirect"));
    expect(body).toMatch(/^require \[.*"vacation".*"copy".*\];/m);
    expect(parseScript(script)?.junk.blocked).toEqual(["bob@blocked.example", "spam.example"]);
  });

  it("forwards without a copy and dates replies in their zone, inside the spam guard, with no user include", () => {
    const script = code(
      buildScript(
        rules({
          forwarding: { enabled: true, address: "copy@example.org", keepCopy: false },
          vacation: {
            enabled: true,
            from: "2026-11-01",
            to: "2026-11-08",
            subject: "",
            message: "Away",
            contactsOnly: false,
          },
          zone: "-0800",
        }),
        ctx,
      ),
    );
    expect(script).toContain('redirect "copy@example.org";');
    expect(script).toContain(
      'if allof (currentdate :zone "-0800" :value "ge" "date" "2026-11-01", currentdate :zone "-0800" :value "le" "date" "2026-11-08") {',
    );
    // The spam/bulk guard wraps both the reply and the redirect; a user script is never included.
    expect(script).toContain("if not anyof (");
    expect(script).not.toContain("include :personal");
  });

  it("guards the redirect: our DMARC fail, or own-domain mail our top-most results don't pass; the message stays", () => {
    const forward = (keepCopy: boolean) =>
      code(buildScript(rules({ forwarding: { enabled: true, address: "copy@example.org", keepCopy } }), ctx));
    const guard = forwardingGuard(["mail.a.test"], "a.test") ?? "";
    expect(guard).toBe(
      `anyof (header :matches "Authentication-Results" ["mail.a.test;*dmarc=fail*"], allof (anyof (address :domain :is "from" "a.test", address :domain :matches "from" "*.a.test"), header :index 1 :matches "Authentication-Results" ["mail.a.test;*"], anyof (anyof (address :count "gt" :comparator "i;ascii-numeric" :all "from" "1", header :count "gt" :comparator "i;ascii-numeric" "from" "1"), not header :index 1 :regex "Authentication-Results" "${dmarcPassRegex("a.test").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")))`,
    );
    for (const keepCopy of [true, false]) {
      const body = forward(keepCopy);
      const redirect = `redirect${keepCopy ? " :copy" : ""} "copy@example.org";`;
      expect(body).toContain(`if not ${guard} {\n    ${redirect}\n  }`);
      // Inside the spam/bulk guard, which is unchanged; the guard's extensions are required.
      expect(body.indexOf('header :contains "X-Spam-Status" "Yes"')).toBeLessThan(body.indexOf(guard));
      expect(body).toMatch(/^require \[.*"index", "regex", "relational", "comparator-i;ascii-numeric"\];/m);
      expect(body).not.toMatch(/require \[[^\]]*"variables"/);
    }
  });

  it("writes only plain hostnames into the guard, and only the DMARC-fail part without a usable domain", () => {
    expect(forwardingGuard([], "a.test")).toBeNull();
    expect(
      forwardingGuard(["", "*", "a*b.example", 'evil"; stop; #.example', "bad\\id.example", "nodot"], "a.test"),
    ).toBeNull();
    expect(forwardingGuard(["MX1.Example.org", "mx1.example.org", "x?.example"], null)).toBe(
      'header :matches "Authentication-Results" ["mx1.example.org;*dmarc=fail*"]',
    );
    for (const domain of ["", "*.a.test", 'a"b.test', "nodot"]) {
      expect(forwardingGuard(["mail.a.test"], domain)).toBe(
        'header :matches "Authentication-Results" ["mail.a.test;*dmarc=fail*"]',
      );
    }
    const noDomain = code(
      buildScript(rules({ forwarding: { enabled: true, address: "copy@example.org", keepCopy: true } }), {
        ...ctx,
        mailboxDomain: null,
      }),
    );
    expect(noDomain).not.toContain(":index");
    expect(noDomain).not.toMatch(/"regex"/);
    const none = code(
      buildScript(rules({ forwarding: { enabled: true, address: "copy@example.org", keepCopy: true } }), {
        ...ctx,
        authservIds: [],
      }),
    );
    expect(none).toContain('  redirect :copy "copy@example.org";');
    expect(none).not.toContain("Authentication-Results");
  });

  it("matches only a results header that ends in a DMARC pass, never one with the words earlier", () => {
    // Rust regex semantics as Stalwart uses them; [[:space:]] is the ASCII class.
    const re = new RegExp(dmarcPassRegex("a.test").replace("[[:space:]]", "\\s"));
    const ours = (last: string) =>
      `mail.a.test;\tspf=pass smtp.mailfrom=a@b.example;\tiprev=pass policy.iprev=192.0.2.1;\t${last}`;
    expect(re.test(ours("dmarc=pass header.from=a.test policy.dmarc=reject"))).toBe(true);
    expect(re.test(ours("dmarc=pass header.from=a.test"))).toBe(true);
    expect(re.test(ours("dmarc=pass (ok) header.from=a.test policy.dmarc=none"))).toBe(true);
    expect(re.test(ours("dmarc=pass header.from=mail.a.test policy.dmarc=none"))).toBe(true); // a subdomain
    for (const last of [
      // A pass for another domain never counts, nor one that only ends like ours.
      "dmarc=pass header.from=evil.example policy.dmarc=none",
      "dmarc=pass header.from=evila.test policy.dmarc=none",
      "dmarc=pass header.from=a.test.evil.example",
      "dmarc=pass header.from=aXtest",
      // What Stalwart writes for more than one From (verified on v0.16.27).
      "dmarc=none header.from= policy.dmarc=none",
      "dmarc=fail header.from=a.test policy.dmarc=reject",
      "dmarc=none header.from=a.test",
      "dmarc=temperror (dns error) header.from=a.test policy.dmarc=none",
      "dmarc=permerror header.from=a.test",
    ]) {
      expect(re.test(ours(last))).toBe(false);
    }
    // A quoted MAIL FROM local part lands verbatim in our header (verified on v0.16.27): not at the end, so no match.
    const injected = `mail.a.test;\tspf=temperror smtp.mailfrom="x; dmarc=pass header.from=a.test policy.dmarc=none@o.example";\tdmarc=temperror (dns error) header.from=a.test policy.dmarc=none`;
    expect(re.test(injected)).toBe(false);
  });

  it("adds no forwarding guard to automatic replies", () => {
    const body = code(
      buildScript(
        rules({
          vacation: { enabled: true, from: null, to: null, subject: "", message: "Away", contactsOnly: false },
        }),
        ctx,
      ),
    );
    expect(body).toContain("vacation :days");
    expect(body).not.toContain("Authentication-Results");
  });

  it("upgrades a script an older generator wrote to exactly what it writes today", () => {
    for (const keepCopy of [true, false]) {
      const r = rules({
        forwarding: { enabled: true, address: "copy@example.org", keepCopy },
        vacation: {
          enabled: true,
          from: null,
          to: null,
          subject: "",
          message: "I may redirect you.",
          contactsOnly: false,
        },
        junk: { blocked: ["spam.example"], safe: [], trustedOnly: false },
      });
      const today = buildScript(r, ctx);
      const older = [
        buildScript(r, { ...ctx, authservIds: [] }), // before 2026-10-30: bare redirect
        buildScript(r, { ...ctx, mailboxDomain: null }), // the DMARC-fail-only guard
        buildScript(r, { ...ctx, authservIds: ["old.a.test"] }), // another authserv-id
        buildScript(r, { ...ctx, authservIds: ["mail.a.test", "mx2.a.test"] }),
      ];
      for (const before of older) {
        expect(before).not.toBe(today);
        expect(upgradeManagedScript(before, ctx.authservIds, ctx.mailboxDomain)).toBe(today);
      }
      expect(upgradeManagedScript(today, ctx.authservIds, ctx.mailboxDomain)).toBeNull();
    }
  });

  it("leaves alone anything that isn't precisely a generator's forwarding script", () => {
    const fwd = rules({ forwarding: { enabled: true, address: "copy@example.org", keepCopy: true } });
    const before = buildScript(fwd, { ...ctx, authservIds: [] });
    const up = (t: string) => upgradeManagedScript(t, ctx.authservIds, ctx.mailboxDomain);
    expect(upgradeManagedScript(before, [], "a.test")).toBeNull(); // no ids
    expect(up(buildScript(DEFAULT_RULES, { ...ctx, authservIds: [] }))).toBeNull();
    expect(up('require ["copy"];\nredirect :copy "copy@example.org";\n')).toBeNull();
    const doubled = before.replace(
      '  redirect :copy "copy@example.org";\n',
      '  redirect :copy "copy@example.org";\n  redirect :copy "copy@example.org";\n',
    );
    expect(up(doubled)).toBeNull();
    expect(up(before.replace('"copy@example.org";', '"other@example.org";'))).toBeNull();
    // A require line we didn't write (unparseable names) leaves the script alone instead of throwing.
    expect(up(before.replace(/^require \[(.*)\];$/m, "require [$1, fileinto];"))).toBeNull();
    // A hand-made "guard" that isn't exactly the generator's is not replaced.
    const handMade = buildScript(fwd, ctx).replace("*.a.test", "*.evil.test");
    expect(up(handMade)).toBeNull();
  });

  it("uses contacts for 'contacts only' rules, and skips a contacts-only reply with no contacts", () => {
    const r = rules({
      vacation: { enabled: true, from: null, to: null, subject: "", message: "Away", contactsOnly: true },
      junk: { blocked: [], safe: [], trustedOnly: true },
    });
    expect(usesContacts(r)).toBe(true);
    expect(usesContacts(DEFAULT_RULES)).toBe(false);
    const none = code(buildScript(r, ctx));
    expect(none).not.toContain("vacation :days");
    // Trusted only with nobody trusted: everything goes to Junk (the settings screen says so).
    expect(none).toContain('if true {\n  fileinto :specialuse "\\\\Junk" "Junk";\n  stop;\n}');
    const some = code(buildScript(r, { ...ctx, contacts: ["friend@example.org"] }));
    expect(some).toContain('if address :all :comparator "i;unicode-casemap" :is "from" ["friend@example.org"] {');
    expect(some).toContain("elsif true {");
    expect(some).toContain('vacation :days 3 :addresses ["sam@a.test", "hi@a.test"] "Away";');
  });

  it("caps contact addresses by count and size, skipping invalid and repeated ones", () => {
    expect(fitContacts(["A@x.co", "a@x.co", "bad", "b@x.co"], 1_000)).toEqual(["a@x.co", "b@x.co"]);
    expect(fitContacts(["a@x.co", "b@x.co"], 11)).toEqual(["a@x.co"]);
    const many = Array.from({ length: MAX_CONTACT_ADDRESSES + 5 }, (_, i) => `p${String(i)}@x.co`);
    expect(fitContacts(many, 1_000_000)).toHaveLength(MAX_CONTACT_ADDRESSES);
  });

  it("reads a time zone's offset", () => {
    expect(zoneOffset("UTC")).toBe("+0000");
    expect(zoneOffset("America/Vancouver", new Date("2026-01-15T12:00:00Z"))).toBe("-0800");
    expect(zoneOffset("Asia/Kolkata", new Date("2026-01-15T12:00:00Z"))).toBe("+0530");
    expect(zoneOffset("Not/AZone")).toBe("+0000");
  });
});

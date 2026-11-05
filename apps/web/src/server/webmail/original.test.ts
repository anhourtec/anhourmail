// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { internalMailTag } from "@anhourmail/core/webmail";

import {
  authLabel,
  authResults,
  delayLabel,
  deliveryDelaySeconds,
  IMPORTED_READER_NOTE,
  IMPORTED_RESULTS_NOTE,
  isImportedCopy,
  isImportedMail,
  isInternalMail,
  oldProviderResults,
  originalChecks,
  ourAuthResultsHeader,
  parseHeaderBlock,
  type RawHeader,
  receivedWith,
  receivedBy,
  readerChecks,
  senderChecks,
  stripComments,
  trustedAuthservIds,
} from "./original";
import { senderVerified } from "./image-proxy";

const OURS = ["mail.dev.test"];

// The order our dev mail server writes on port 25 (captured from a real delivery on Stalwart v0.16.27): its trace
// headers sit above the sender's, with Authentication-Results directly below its Received. A DKIM result is added.
const STAMPED = [
  "Delivered-To: bob@dev.test",
  "X-Spam-Status: No",
  "Received: from mx.example.org (mx.example.org [192.0.2.10])",
  "\tby mail.dev.test (Stalwart SMTP) with ESMTP id 1;",
  "\tFri, 23 Oct 2026 17:44:01 +0000",
  "Authentication-Results: mail.dev.test;",
  "\tspf=pass (mail.dev.test: domain of probe@example.org designates 192.0.2.10 as permitted sender) smtp.helo=mx.example.org;",
  "\tspf=pass (mail.dev.test: domain of probe@example.org designates 192.0.2.10 as permitted sender) smtp.mailfrom=probe@example.org;",
  "\tdkim=pass header.d=example.org header.s=sel header.b=abc;",
  "\tiprev=pass policy.iprev=192.0.2.10;",
  "\tdmarc=pass header.from=example.org policy.dmarc=reject",
  "Received-SPF: pass (mail.dev.test: domain of probe@example.org designates 192.0.2.10 as permitted sender)",
  "X-Spam-Score: ham, score=0.00",
  "Return-Path: <probe@example.org>",
  "From: Probe <probe@example.org>",
  "Subject: hi",
  "",
  "Authentication-Results: mail.dev.test; spf=fail",
  "body",
].join("\r\n");

const RCVD = "Received: from mx.b.example by mail.dev.test (Stalwart SMTP); Fri, 23 Oct 2026 17:44:01 +0000\r\n";

const FORGED =
  "Authentication-Results: mail.dev.test; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example";

describe("parseHeaderBlock", () => {
  it("unfolds continuation lines and stops at the body", () => {
    const h = parseHeaderBlock(STAMPED);
    expect(h.map((x) => x.name)).toEqual([
      "Delivered-To",
      "X-Spam-Status",
      "Received",
      "Authentication-Results",
      "Received-SPF",
      "X-Spam-Score",
      "Return-Path",
      "From",
      "Subject",
    ]);
    expect(h[2]?.value).toContain("by mail.dev.test (Stalwart SMTP)");
  });

  it("handles LF-only messages and a missing body", () => {
    expect(parseHeaderBlock("A: 1\n  2\nB: 3")).toEqual([
      { name: "A", value: "1 2" },
      { name: "B", value: "3" },
    ]);
  });
});

describe("receivedBy", () => {
  it("reads the by host, ignoring comments and case", () => {
    expect(receivedBy("from a (by evil.example) by MAIL.dev.test (Stalwart SMTP) with ESMTP id 1;")).toBe(
      "mail.dev.test",
    );
    expect(receivedBy("from a with ESMTP id 1")).toBeNull();
  });
});

describe("stripComments", () => {
  it("removes nested comments but keeps quoted strings", () => {
    expect(stripComments('a (x (y) z) b "(kept)"')).toBe('a   b "(kept)"');
  });
});

describe("authResults", () => {
  it("reads SPF, DKIM and DMARC from our own topmost header", () => {
    const r = authResults(parseHeaderBlock(STAMPED), OURS);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(authLabel(r.spf)).toBe("PASS with IP 192.0.2.10");
    expect(authLabel(r.dkim)).toBe("PASS with domain example.org");
    expect(authLabel(r.dmarc)).toBe("PASS with domain example.org");
  });

  it("matches the authserv-id case-insensitively", () => {
    expect(authResults(parseHeaderBlock(STAMPED), ["MAIL.DEV.TEST"])).not.toBeNull();
  });

  it("ignores a forged header with our id below the sender's headers on mail from outside", () => {
    const raw = STAMPED.replace("Subject: hi", `Subject: hi\r\n${FORGED}`).replace(
      "dkim=pass header.d=example.org",
      "dkim=none",
    );
    const r = authResults(parseHeaderBlock(raw), OURS);
    expect(r && authLabel(r.dkim)).toBe("NONE");
    expect(r?.dmarc.domain).toBe("example.org");
  });

  it("is not checked when outside mail carries only a forged header (ours missing below our Received)", () => {
    const raw = [
      "Received: from mx.example.org by mail.dev.test (Stalwart SMTP) with ESMTP id 2; Fri, 23 Oct 2026 17:44:01 +0000",
      "Return-Path: <a@b.example>",
      FORGED,
      "Subject: x",
      "",
      "",
    ].join("\r\n");
    expect(authResults(parseHeaderBlock(raw), OURS)).toBeNull();
  });

  it("is not checked for mail submitted from inside, even with a forged header and no Received at all", () => {
    // What a local submission looks like in the recipient's mailbox (captured on v0.16.27 before the Sieve strip).
    const raw = [
      "Delivered-To: bob@dev.test",
      "X-Spam-Status: No",
      "DKIM-Signature: v=1; a=rsa-sha256; s=sel; d=dev.test; h=From; b=abc",
      "From: alice@dev.test",
      "To: bob@dev.test",
      FORGED,
      "",
      "",
    ].join("\r\n");
    expect(authResults(parseHeaderBlock(raw), OURS)).toBeNull();
  });

  it("is not checked when the topmost Received is another host's, even if our pair appears below", () => {
    const raw = [
      "Received: from x by mx.other.example; Fri, 23 Oct 2026 17:44:01 +0000",
      "Authentication-Results: mx.other.example; spf=pass smtp.mailfrom=a@b.example",
      "Received: from y by mail.dev.test; Fri, 23 Oct 2026 17:43:01 +0000",
      FORGED,
      "",
      "",
    ].join("\r\n");
    expect(authResults(parseHeaderBlock(raw), OURS)).toBeNull();
  });

  it("is not checked when the header under our Received is someone else's, or another header comes first", () => {
    const rcvd = "Received: from x by mail.dev.test; Fri, 23 Oct 2026 17:44:01 +0000";
    const other = `${rcvd}\r\nAuthentication-Results: mx.attacker.example; dkim=pass header.d=bank.example\r\n${FORGED}\r\n\r\n`;
    expect(authResults(parseHeaderBlock(other), OURS)).toBeNull();
    const gap = `${rcvd}\r\nReturn-Path: <a@b.example>\r\n${FORGED}\r\n\r\n`;
    expect(authResults(parseHeaderBlock(gap), OURS)).toBeNull();
  });

  it("uses only the first of several results headers, skipping ARC headers in between", () => {
    const raw = [
      "Received: from x by mail.dev.test; Fri, 23 Oct 2026 17:44:01 +0000",
      "ARC-Seal: i=1; a=rsa-sha256; cv=none; d=dev.test; s=sel; b=abc",
      "Authentication-Results: mail.dev.test; spf=fail smtp.mailfrom=a@b.example",
      FORGED,
      "",
      "",
    ].join("\r\n");
    const r = authResults(parseHeaderBlock(raw), OURS);
    expect(r && authLabel(r.spf)).toBe("FAIL");
    expect(r && authLabel(r.dkim)).toBe("NONE");
  });

  it("is not checked when there is no header (sent mail)", () => {
    expect(authResults(parseHeaderBlock("From: me@dev.test\r\nSubject: x\r\n\r\nhi"), OURS)).toBeNull();
  });

  it("is not checked when the trusted list is empty", () => {
    expect(ourAuthResultsHeader(parseHeaderBlock(STAMPED), [" ", ""])).toBeNull();
  });

  it("reports failures and methods we didn't record as none", () => {
    const raw = `${RCVD}Authentication-Results: mail.dev.test; spf=fail smtp.mailfrom=a@b.example; dmarc=fail (p=reject) header.from=b.example\r\n\r\n`;
    const r = authResults(parseHeaderBlock(raw), OURS);
    expect(r && authLabel(r.spf)).toBe("FAIL");
    expect(r && authLabel(r.dkim)).toBe("NONE");
    expect(r && authLabel(r.dmarc)).toBe("FAIL");
  });

  it("prefers the passing DKIM signature and the mail-from SPF check; temporary errors are shown as such", () => {
    const raw = [
      RCVD.trimEnd(),
      "Authentication-Results: mail.dev.test;",
      " spf=temperror (dns) smtp.helo=x.example;",
      " spf=temperror (dns) smtp.mailfrom=a@b.example;",
      " dkim=fail header.d=old.example; dkim=pass header.i=@b.example",
      "",
      "",
    ].join("\r\n");
    const r = authResults(parseHeaderBlock(raw), OURS);
    expect(r && authLabel(r.spf)).toBe("TEMPERROR");
    expect(r && authLabel(r.dkim)).toBe("PASS with domain b.example");
  });

  it("ignores a header with no results", () => {
    const r = authResults(parseHeaderBlock(`${RCVD}Authentication-Results: mail.dev.test; none\r\n\r\n`), OURS);
    expect(r && authLabel(r.spf)).toBe("NONE");
  });
});

describe("delivery delay", () => {
  it("counts seconds from the Date header to receipt", () => {
    expect(deliveryDelaySeconds("2026-10-23T17:44:01Z", "2026-10-23T17:44:04Z")).toBe(3);
    expect(deliveryDelaySeconds("Fri, 23 Oct 2026 17:44:01 +0000", "2026-10-23T17:45:01Z")).toBe(60);
  });

  it("treats a Date in the future as no delay and unreadable dates as unknown", () => {
    expect(deliveryDelaySeconds("2026-10-23T17:44:09Z", "2026-10-23T17:44:04Z")).toBe(0);
    expect(deliveryDelaySeconds("not a date", "2026-10-23T17:44:04Z")).toBeNull();
    expect(deliveryDelaySeconds(null, "2026-10-23T17:44:04Z")).toBeNull();
  });

  it("labels the delay in readable units", () => {
    expect(delayLabel(1)).toBe("Delivered after 1 second");
    expect(delayLabel(45)).toBe("Delivered after 45 seconds");
    expect(delayLabel(600)).toBe("Delivered after 10 minutes");
    expect(delayLabel(3 * 3600)).toBe("Delivered after 3 hours");
    expect(delayLabel(3 * 86400)).toBe("Delivered after 3 days");
  });
});

describe("trustedAuthservIds", () => {
  it("uses the configured list when set", () => {
    expect(trustedAuthservIds(" A.example , b.example ", ["mx1.x"], true)).toEqual(["a.example", "b.example"]);
  });

  it("falls back to our MX hosts, plus the dev server outside production", () => {
    expect(trustedAuthservIds(undefined, ["mx1.example.org"], true)).toEqual(["mx1.example.org"]);
    expect(trustedAuthservIds("", ["mx1.example.org"], false)).toEqual(["mx1.example.org", "mail.dev.test"]);
  });
});

describe("senderChecks", () => {
  it("gives the passing SPF and DKIM domains", () => {
    expect(senderChecks(authResults(parseHeaderBlock(STAMPED), OURS))).toEqual({
      mailedBy: "example.org",
      signedBy: "example.org",
    });
  });

  it("gives nothing when unchecked or failing", () => {
    expect(senderChecks(null)).toEqual({ mailedBy: null, signedBy: null });
    const raw = `${RCVD}Authentication-Results: mail.dev.test; spf=fail smtp.mailfrom=a@b.example\r\n\r\n`;
    expect(senderChecks(authResults(parseHeaderBlock(raw), OURS))).toEqual({ mailedBy: null, signedBy: null });
  });
});

describe("isInternalMail", () => {
  // A dummy 64-hex key, built in code so secret scanners don't take it for a real one.
  const KEY = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");
  const FROM = "alice@dev.test";
  const MID = "18e3.f7@mail.dev.test";
  const tag = internalMailTag(KEY, FROM, MID) ?? "";
  const internal = (h: RawHeader[], from: string, key: string) => isInternalMail(h, from, key, OURS);
  // As a locally submitted message reaches a mailbox (captured on Stalwart v0.16.27): no Received, no results.
  const local = (extra: { name: string; value: string }[] = []) => [
    { name: "Delivered-To", value: "bob@dev.test" },
    { name: "X-Spam-Status", value: "No" },
    { name: "X-AnhourMail-Internal", value: tag },
    { name: "From", value: `<${FROM}>` },
    { name: "Message-ID", value: `<${MID}>` },
    ...extra,
  ];

  it("accepts our server's marker for this From and Message-ID", () => {
    expect(internal(local(), FROM, KEY)).toBe(true);
    expect(internal(local(), "Alice@Dev.Test", KEY)).toBe(true);
    // A copy redirected by a mailbox's rule keeps the original marker under our LMTP Received: its From is ours.
    const redirected = [{ name: "Received", value: "from localhost by mail.dev.test with LMTP id 1" }, ...local()];
    expect(internal(redirected, FROM, KEY)).toBe(true);
  });

  it("refuses a marker for another From, Message-ID or key", () => {
    expect(internal(local(), "bob@dev.test", KEY)).toBe(false);
    expect(internal(local(), FROM, "fedcba9876543210".repeat(4))).toBe(false);
    const otherId = local().map((h) => (h.name === "Message-ID" ? { ...h, value: "<x@mail.dev.test>" } : h));
    expect(internal(otherId, FROM, KEY)).toBe(false);
  });

  it("refuses no marker, a made-up one, or any header doubled", () => {
    expect(
      internal(
        local().filter((h) => h.name !== "X-AnhourMail-Internal"),
        FROM,
        KEY,
      ),
    ).toBe(false);
    const madeUp = local().map((h) => (h.name === "X-AnhourMail-Internal" ? { ...h, value: "ab".repeat(32) } : h));
    expect(internal(madeUp, FROM, KEY)).toBe(false);
    expect(internal(local([{ name: "x-anhourmail-internal ", value: tag }]), FROM, KEY)).toBe(false);
    expect(internal(local([{ name: "Message-ID", value: "<y@mail.dev.test>" }]), FROM, KEY)).toBe(false);
    expect(internal(local([{ name: "From", value: "mallory@evil.example" }]), FROM, KEY)).toBe(false);
    expect(
      internal(
        local().filter((h) => h.name !== "Message-ID"),
        FROM,
        KEY,
      ),
    ).toBe(false);
  });

  it("is false, never a throw, for a malformed key", () => {
    expect(internal(local(), FROM, "short")).toBe(false);
  });

  it("is false for anything that shows it arrived on port 25, wherever it sits", () => {
    const rcvd = (w: string) => ({ name: "Received", value: `from mx.example.org by mail.dev.test with ${w} id 1; x` });
    const ar = { name: "Authentication-Results", value: "mx.other.example; dmarc=pass" };
    // A copy redirected from outside: our LMTP Received on top, the port 25 block further down.
    expect(internal([rcvd("LMTP"), ...local([rcvd("ESMTP"), ar])], FROM, KEY)).toBe(false);
    for (const extra of [
      [rcvd("ESMTP")],
      [rcvd("ESMTPS")],
      [rcvd("SMTP")],
      [{ name: "Received", value: "from x by mail.dev.test; date" }],
      [ar],
      [{ name: "authentication-results", value: "anything" }],
      [{ name: "Received-SPF", value: "pass" }],
      [{ name: "Authentication-Results\u00a0", value: "spelled oddly" }],
    ]) {
      expect(internal(local(extra), FROM, KEY)).toBe(false);
    }
    // Another host's Received (the sender's own client wrote it) and our LMTP hop don't count as port 25.
    expect(internal(local([{ name: "Received", value: "from a by smtp.other.example with ESMTPSA" }]), FROM, KEY)).toBe(
      true,
    );
    expect(internal([rcvd("LMTP"), ...local()], FROM, KEY)).toBe(true);
  });

  it("matches header names exactly: look-alikes count, only the exact name is the marker", () => {
    const renamed = (name: string) => local().map((h) => (h.name === "X-AnhourMail-Internal" ? { ...h, name } : h));
    for (const odd of [
      "X-AnhourMail-Internal\u00a0",
      "\ufeffX-AnhourMail-Internal",
      "X-AnhourMail-Internal\v",
      "X_AnhourMail_Internal",
    ]) {
      expect(internal(renamed(odd), FROM, KEY)).toBe(false); // the one marker-like header isn't exactly named
      expect(internal(local([{ name: odd, value: tag }]), FROM, KEY)).toBe(false); // two marker-like headers
    }
    expect(internal(renamed("x-anhourmail-internal"), FROM, KEY)).toBe(true);
    const oddId = local().map((h) => (h.name === "Message-ID" ? { ...h, name: "Message-ID\u00a0" } : h));
    expect(internal(oddId, FROM, KEY)).toBe(false);
  });
});

describe("exact header names elsewhere", () => {
  it("reads the protocol of a Received header", () => {
    expect(receivedWith("from a (b) by mail.dev.test (Stalwart SMTP) with LMTP id 1; x")).toBe("lmtp");
    expect(receivedWith("from a by b; x")).toBeNull();
  });

  it("never trusts a results pair whose names only look right", () => {
    // Stalwart keeps these names as written and its deleteheader doesn't match them (verified on v0.16.27), so a
    // submitter could plant them: the raw parse must not trim them into the real names.
    const raw =
      "Delivered-To: bob@dev.test\r\nReceived\u00a0: from x by mail.dev.test with ESMTP id 1; x\r\n" +
      "Authentication-Results\u00a0: mail.dev.test; dmarc=pass header.from=bank.example\r\nFrom: a@dev.test\r\n\r\n";
    const parsed = parseHeaderBlock(raw);
    expect(parsed.map((h) => h.name)).toContain("Received\u00a0");
    expect(ourAuthResultsHeader(parsed, OURS)).toBeNull();
    const jmap = [
      { name: "Received\ufeff", value: "from x by mail.dev.test with ESMTP id 1; x" },
      { name: "Authentication-Results", value: "mail.dev.test; dmarc=pass" },
    ];
    expect(ourAuthResultsHeader(jmap, OURS)).toBeNull();
  });

  it("still reads names with ASCII space or tab before the colon as the field (as Stalwart does)", () => {
    const raw = `${RCVD}Authentication-Results \t: mail.dev.test; dmarc=pass header.from=example.org\r\n\r\n`;
    expect(ourAuthResultsHeader(parseHeaderBlock(raw), OURS)).toMatch(/^mail\.dev\.test;/);
  });
});

describe("results that load images without asking (ADR-0027, security-audit run-55)", () => {
  it("needs DMARC passing on our results: a DKIM pass alone (an `l=` signature replayed with images) isn't enough", () => {
    const ok = authResults(parseHeaderBlock(STAMPED), OURS);
    expect(senderVerified("probe@example.org", ok)).toBe(true);
    for (const dmarc of [
      "dmarc=none header.from=example.org",
      "dmarc=fail header.from=example.org policy.dmarc=none",
    ]) {
      const raw = STAMPED.replace("dmarc=pass header.from=example.org policy.dmarc=reject", dmarc);
      const r = authResults(parseHeaderBlock(raw), OURS);
      expect(r?.dkim.result).toBe("pass");
      expect(senderVerified("probe@example.org", r)).toBe(false);
    }
    // DMARC for another domain than the From's doesn't count either.
    expect(senderVerified("probe@other.example", ok)).toBe(false);
  });
});

describe("imported mail is never verified by us (ADR-0030 §5, SA-64-01)", () => {
  // A source mailbox can hold a copy of mail our server once received (or a forgery of one): our Received with our
  // results right below it. The importer's marker sits above it all, and an APPEND adds no Received of ours.
  const imported = (marker = "X-AnhourMail-Imported") =>
    parseHeaderBlock(`${marker}: 2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50\r\n${STAMPED}`);
  const KEY = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");
  const FROM = "alice@dev.test";
  const MID = "18e3.f7@mail.dev.test";
  const internalHeaders = (top: RawHeader[]) => [
    ...top,
    { name: "X-AnhourMail-Internal", value: internalMailTag(KEY, FROM, MID) ?? "" },
    { name: "From", value: `<${FROM}>` },
    { name: "Message-ID", value: `<${MID}>` },
  ];

  it("ignores our Received and Authentication-Results pair below the marker", () => {
    expect(authResults(parseHeaderBlock(STAMPED), OURS)).not.toBeNull();
    expect(isImportedMail(imported())).toBe(true);
    expect(ourAuthResultsHeader(imported(), OURS)).toBeNull();
    expect(authResults(imported(), OURS)).toBeNull();
    expect(senderVerified("probe@example.org", authResults(imported(), OURS))).toBe(false);
  });

  it("ignores a forged pair whatever the marker's spelling or position", () => {
    for (const spelling of ["x-anhourmail-imported", "X-AnhourMail_Imported", "X-ANHOURMAIL-IMPORTED"]) {
      expect(authResults(imported(spelling), OURS)).toBeNull();
    }
    const below = parseHeaderBlock(STAMPED.replace("Subject: hi", "Subject: hi\r\nX-AnhourMail-Imported: x"));
    expect(isImportedMail(below)).toBe(true);
    expect(authResults(below, OURS)).toBeNull();
  });

  it("refuses the internal-mail marker inside an imported copy", () => {
    expect(isInternalMail(internalHeaders([]), FROM, KEY, OURS)).toBe(true);
    const copied = internalHeaders([{ name: "X-AnhourMail-Imported", value: "2f1d5c7e" }]);
    expect(isInternalMail(copied, FROM, KEY, OURS)).toBe(false);
    expect(senderVerified(FROM, null, isInternalMail(copied, FROM, KEY, OURS))).toBe(false);
  });

  it("leaves ordinary mail alone", () => {
    expect(isImportedMail(parseHeaderBlock(STAMPED))).toBe(false);
    expect(isImportedMail([{ name: "X-AnhourMail-Importer", value: "x" }])).toBe(false);
  });
});

describe("the imported note on Original message and in the reader (ADR-0030 §5, slice 12)", () => {
  // An imported copy as a provider would have stored it: its own results on top, then the sender's headers.
  const PROVIDER = [
    "X-AnhourMail-Imported: 2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50",
    "Received: by 2002:a05:6000:1 with SMTP id x; Tue, 3 Nov 2026 10:00:00 -0800",
    "ARC-Authentication-Results: i=1; mx.old.example; spf=fail",
    "Authentication-Results: mx.old.example; spf=pass smtp.mailfrom=probe@example.org;",
    "\tdkim=pass header.d=example.org; dmarc=pass header.from=example.org",
    "Authentication-Results: mx.old.example; spf=fail",
    "From: Probe <probe@example.org>",
    "Subject: hi",
    "",
    "body",
  ].join("\r\n");

  it("shows the old provider's results for an imported copy, labelled, and never as ours", () => {
    const headers = parseHeaderBlock(PROVIDER);
    const checks = originalChecks(headers, OURS);
    expect(checks.imported).toBe(true);
    expect(checks.auth?.spf.result).toBe("pass");
    expect(checks.auth?.dkim).toMatchObject({ result: "pass", domain: "example.org" });
    expect(checks.auth?.dmarc.result).toBe("pass");
    // Our own view of it stays empty: nothing verifies the sender or loads images from it.
    expect(authResults(headers, OURS)).toBeNull();
    expect(senderVerified("probe@example.org", authResults(headers, OURS))).toBe(false);
    expect(IMPORTED_RESULTS_NOTE).toBe("Imported; these results come from the old provider, not AnhourMail.");
  });

  it("reads only results below the marker, and says nothing was recorded when there are none", () => {
    const ID = "2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50";
    expect(
      oldProviderResults(parseHeaderBlock(`X-AnhourMail-Imported: ${ID}\r\nFrom: a@b.example\r\n\r\n`)),
    ).toBeNull();
    expect(oldProviderResults(parseHeaderBlock(STAMPED))).toBeNull();
  });

  it("never shows a sender's own forged marker as an imported copy (SA-66-01)", () => {
    // A sender adds the marker lower down with PASS results under it: not the old provider's, and not verified either.
    const forged = [
      "From: Probe <probe@example.org>",
      "X-AnhourMail-Imported: 2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50",
      "Authentication-Results: mx.old.example; spf=pass smtp.mailfrom=probe@example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org",
      "Subject: hi",
      "",
      "body",
    ].join("\r\n");
    const below = parseHeaderBlock(forged);
    expect(isImportedCopy(below)).toBe(false);
    expect(oldProviderResults(below)).toBeNull();
    expect(originalChecks(below, OURS)).toEqual({ imported: false, auth: null });
    expect(readerChecks(below, OURS)).toEqual({ mailedBy: null, signedBy: null, imported: false });
    // Below our own pair, too: our results are refused, nothing is shown as the old provider's.
    const underOurs = parseHeaderBlock(
      STAMPED.replace("Subject: hi", "Subject: hi\r\nX-AnhourMail-Imported: 2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50"),
    );
    expect(originalChecks(underOurs, OURS)).toEqual({ imported: false, auth: null });
    // On top but not in the importer's exact form (another spelling, or a value that isn't an import id).
    for (const top of ["x-anhourmail-imported: 2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50", "X-AnhourMail-Imported: x"]) {
      const h = parseHeaderBlock(`${top}\r\n${forged}`);
      expect(isImportedCopy(h)).toBe(false);
      expect(originalChecks(h, OURS)).toEqual({ imported: false, auth: null });
    }
    // Our importer's form on top: the old provider's results, labelled.
    expect(isImportedCopy(parseHeaderBlock(PROVIDER))).toBe(true);
  });

  it("keeps ordinary mail on our own results", () => {
    const checks = originalChecks(parseHeaderBlock(STAMPED), OURS);
    expect(checks.imported).toBe(false);
    expect(checks.auth?.dmarc.result).toBe("pass");
  });

  it("gives the reader's details a note instead of mailed-by and signed-by", () => {
    const imported = readerChecks(
      parseHeaderBlock(`X-AnhourMail-Imported: 2f1d5c7e-4c1a-4a51-9b55-0b7c2d3e4f50\r\n${STAMPED}`),
      OURS,
    );
    expect(imported).toEqual({ mailedBy: null, signedBy: null, imported: true });
    expect(readerChecks(parseHeaderBlock(STAMPED), OURS)).toEqual({
      mailedBy: "example.org",
      signedBy: "example.org",
      imported: false,
    });
    expect(IMPORTED_READER_NOTE).toMatch(/^Imported; not checked/);
  });
});

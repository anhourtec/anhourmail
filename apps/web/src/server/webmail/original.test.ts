// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  authLabel,
  authResults,
  delayLabel,
  deliveryDelaySeconds,
  ourAuthResultsHeader,
  parseHeaderBlock,
  receivedBy,
  senderChecks,
  stripComments,
  trustedAuthservIds,
} from "./original";

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

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  authLabel,
  authResults,
  delayLabel,
  deliveryDelaySeconds,
  parseHeaderBlock,
  senderChecks,
  stripComments,
  trustedAuthservIds,
} from "./original";

const OURS = ["mail.dev.test"];

// The shape our dev mail server stamps (captured from a real delivery), plus a DKIM result.
const STAMPED = [
  "Authentication-Results: mail.dev.test;",
  "\tspf=pass (mail.dev.test: domain of probe@example.org designates 192.0.2.10 as permitted sender) smtp.helo=mx.example.org;",
  "\tspf=pass (mail.dev.test: domain of probe@example.org designates 192.0.2.10 as permitted sender) smtp.mailfrom=probe@example.org;",
  "\tdkim=pass header.d=example.org header.s=sel header.b=abc;",
  "\tiprev=pass policy.iprev=192.0.2.10;",
  "\tdmarc=pass header.from=example.org policy.dmarc=reject",
  "Received: from mx.example.org (mx.example.org [192.0.2.10])",
  "\tby mail.dev.test (Stalwart SMTP) with ESMTP id 1;",
  "\tFri, 23 Oct 2026 17:44:01 +0000",
  "From: Probe <probe@example.org>",
  "Subject: hi",
  "",
  "Authentication-Results: mail.dev.test; spf=fail",
  "body",
].join("\r\n");

describe("parseHeaderBlock", () => {
  it("unfolds continuation lines and stops at the body", () => {
    const h = parseHeaderBlock(STAMPED);
    expect(h.map((x) => x.name)).toEqual(["Authentication-Results", "Received", "From", "Subject"]);
    expect(h[1]?.value).toContain("by mail.dev.test (Stalwart SMTP)");
  });

  it("handles LF-only messages and a missing body", () => {
    expect(parseHeaderBlock("A: 1\n  2\nB: 3")).toEqual([
      { name: "A", value: "1 2" },
      { name: "B", value: "3" },
    ]);
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

  it("trusts nothing when the topmost header is someone else's, even if ours appears below", () => {
    const forged = [
      "Authentication-Results: mx.attacker.example; spf=pass smtp.mailfrom=a@b.example; dkim=pass header.d=b.example",
      "Authentication-Results: mail.dev.test; spf=pass smtp.mailfrom=a@b.example",
      "Subject: x",
      "",
      "",
    ].join("\r\n");
    expect(authResults(parseHeaderBlock(forged), OURS)).toBeNull();
  });

  it("is not checked when there is no header (sent mail)", () => {
    expect(authResults(parseHeaderBlock("From: me@dev.test\r\nSubject: x\r\n\r\nhi"), OURS)).toBeNull();
  });

  it("reports failures and methods we didn't record as none", () => {
    const raw =
      "Authentication-Results: mail.dev.test; spf=fail smtp.mailfrom=a@b.example; dmarc=fail (p=reject) header.from=b.example\r\n\r\n";
    const r = authResults(parseHeaderBlock(raw), OURS);
    expect(r && authLabel(r.spf)).toBe("FAIL");
    expect(r && authLabel(r.dkim)).toBe("NONE");
    expect(r && authLabel(r.dmarc)).toBe("FAIL");
  });

  it("prefers the passing DKIM signature and the mail-from SPF check; temporary errors are shown as such", () => {
    const raw = [
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
    const r = authResults(parseHeaderBlock("Authentication-Results: mail.dev.test; none\r\n\r\n"), OURS);
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
    const raw = "Authentication-Results: mail.dev.test; spf=fail smtp.mailfrom=a@b.example\r\n\r\n";
    expect(senderChecks(authResults(parseHeaderBlock(raw), OURS))).toEqual({ mailedBy: null, signedBy: null });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deliveryReport, MAX_REPORTED, refusalOf } from "./delivery";

const NO_MAILBOX = "No mailbox with this address exists.";
const refused = { delivered: "no", smtpReply: "550 5.1.2 Mailbox does not exist.", displayed: "unknown" };

describe("refusalOf", () => {
  it("turns the mail server's reply into a short code and a plain reason, never its text", () => {
    expect(refusalOf("550 5.1.2 Mailbox does not exist.")).toEqual({ code: "5.1.2", reason: NO_MAILBOX });
    expect(refusalOf("550 5.1.1 <x@y>: user unknown")).toEqual({ code: "5.1.1", reason: NO_MAILBOX });
    expect(refusalOf("552-5.2.2 Over quota")).toEqual({ code: "5.2.2", reason: "The recipient's mailbox is full." });
    expect(refusalOf("552 5.3.4 Too big")).toEqual({
      code: "5.3.4",
      reason: "The message is too large for the recipient.",
    });
    expect(refusalOf("556 5.1.10 Null MX")).toEqual({ code: "5.1.10", reason: "This domain doesn't accept mail." });
    expect(refusalOf("452 4.4.5 Rate limit exceeded")).toEqual({
      code: "4.4.5",
      reason: "Too many messages to this address for now. Try again later.",
    });
    expect(refusalOf("550 5.7.1 Policy says no, see https://example.net")).toEqual({
      code: "5.7.1",
      reason: "The receiving server refused this message.",
    });
    expect(refusalOf("451 4.3.0 Try later")).toMatchObject({ code: "4.3.0" });
    expect(refusalOf("554 5.9.9 Whatever")).toEqual({
      code: "5.9.9",
      reason: "The receiving server refused this message.",
    });
  });

  it("keeps only a reply code when there is no enhanced code, and nothing for an odd reply", () => {
    expect(refusalOf("550 Go away")).toEqual({ code: "550", reason: "The receiving server refused this message." });
    for (const odd of ["", "hello 5.1.2", "999 9.9.9 x", null, undefined, 42, "<script>"]) {
      expect(refusalOf(odd)).toEqual({ code: null, reason: "The receiving server refused this message." });
    }
  });
});

describe("deliveryReport", () => {
  it("reports nothing when every recipient was accepted and the hold is over", () => {
    expect(
      deliveryReport({
        undoStatus: "final",
        deliveryStatus: { "bob@dev.test": { delivered: "unknown", smtpReply: "250 2.1.5 Queued" } },
      }),
    ).toEqual({ undelivered: [], settled: true, held: false });
  });

  it("names every refused recipient (partial failure), sorted, and keeps queued ones out", () => {
    const report = deliveryReport({
      undoStatus: "pending",
      deliveryStatus: {
        "zed@dev.test": refused,
        "bob@dev.test": { delivered: "queued", smtpReply: "250 2.1.5 Queued" },
        "amy@dev.test": refused,
        "ext@example.com": { delivered: "queued", smtpReply: "250 2.1.5 Queued" },
      },
    });
    expect(report.undelivered.map((u) => u.email)).toEqual(["amy@dev.test", "zed@dev.test"]);
    expect(report.undelivered[0]).toEqual({ email: "amy@dev.test", code: "5.1.2", reason: NO_MAILBOX });
    expect(report).toMatchObject({ settled: false, held: true });
  });

  it("is settled and not held when every recipient was refused (nothing was held)", () => {
    expect(deliveryReport({ undoStatus: "final", deliveryStatus: { "a@dev.test": refused } })).toEqual({
      undelivered: [{ email: "a@dev.test", code: "5.1.2", reason: NO_MAILBOX }],
      settled: true,
      held: false,
    });
  });

  it("stays unsettled while a recipient is queued or has no status, and with no status at all", () => {
    expect(
      deliveryReport({ undoStatus: "final", deliveryStatus: { "x@example.com": { delivered: "queued" } } }).settled,
    ).toBe(false);
    expect(deliveryReport({ undoStatus: "final", deliveryStatus: { "x@dev.test": {} } }).settled).toBe(false);
    expect(deliveryReport({ undoStatus: "final", deliveryStatus: { "x@dev.test": "no" } }).settled).toBe(false);
    expect(deliveryReport({ undoStatus: "final", deliveryStatus: {} }).settled).toBe(false);
    expect(deliveryReport({ undoStatus: "final", deliveryStatus: null })).toEqual({
      undelivered: [],
      settled: false,
      held: false,
    });
    expect(deliveryReport({ undoStatus: "pending" })).toEqual({ undelivered: [], settled: false, held: true });
    expect(deliveryReport(undefined)).toEqual({ undelivered: [], settled: false, held: false });
  });

  it("reports nothing for an undone send", () => {
    expect(deliveryReport({ undoStatus: "canceled", deliveryStatus: { "a@dev.test": refused } })).toEqual({
      undelivered: [],
      settled: true,
      held: false,
    });
    expect(deliveryReport({ undoStatus: "canceled" })).toMatchObject({ settled: true });
  });

  it("only passes plain addresses on, and at most MAX_REPORTED of them", () => {
    const odd = deliveryReport({
      undoStatus: "final",
      deliveryStatus: { "<a@b>": refused, "no-at-sign": refused, [`${"x".repeat(250)}@b.test`]: refused },
    });
    expect(odd.undelivered).toEqual([]);
    const many = Object.fromEntries(
      Array.from({ length: MAX_REPORTED + 20 }, (_, i) => [`n${String(i)}@dev.test`, refused]),
    );
    expect(deliveryReport({ undoStatus: "final", deliveryStatus: many }).undelivered).toHaveLength(MAX_REPORTED);
  });
});

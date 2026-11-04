// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { WebhookRejected } from "@anhourmail/core/billing";

import {
  parseEvent,
  parseSignatureHeader,
  signatureHeader,
  signPayload,
  verifySignature,
  verifyWebhookBody,
} from "./signature";

const SECRET = "whsec_test_secret";
const OTHER = "whsec_rotated_secret";
const T = 1_793_000_000;
const NOW = new Date(T * 1000);
const ACCOUNT = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const body = JSON.stringify({
  id: "evt_1",
  object: "event",
  type: "invoice.paid",
  created: T - 5,
  livemode: false,
  data: { object: { id: "in_1", object: "invoice", customer: "cus_1", metadata: { account_id: ACCOUNT } } },
});

const rejects = (fn: () => unknown, reason: string) => {
  expect(fn).toThrow(WebhookRejected);
  expect(fn).toThrow(`webhook rejected: ${reason}`);
};

describe("webhook signatures (ADR-0029 §4)", () => {
  it("HMAC-SHA256 over `t.body`: matches an independent computation (OpenSSL) at a fixed timestamp", () => {
    // printf '%s' '1492774577.{"id":"evt_test_webhook","object":"event"}' | openssl dgst -sha256 -hmac whsec_test_secret
    expect(signPayload(SECRET, 1_492_774_577, '{"id":"evt_test_webhook","object":"event"}')).toBe(
      "88a022085c6bdb887b02cb26ff76dd681234d9675c0f22844059f55552a8883a",
    );
  });

  it("parses the processor's published example header (multi-line, with a v0 to ignore)", () => {
    const published =
      "t=1492774577,\nv1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,\nv0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39\n";
    expect(parseSignatureHeader(published)).toEqual({
      t: 1_492_774_577,
      v1: ["5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd"],
    });
  });

  it("accepts a valid signature, and any of several v1 values", () => {
    const header = signatureHeader(SECRET, T, body);
    expect(() => {
      verifySignature(body, header, [SECRET], NOW);
    }).not.toThrow();
    const several = `t=${String(T)},v1=${"0".repeat(64)},v1=${signPayload(SECRET, T, body)},foo=bar`;
    expect(() => {
      verifySignature(body, several, [SECRET], NOW);
    }).not.toThrow();
  });

  it("accepts the second secret during a rotation; an empty secret never verifies", () => {
    const header = signatureHeader(OTHER, T, body);
    expect(() => {
      verifySignature(body, header, [SECRET, OTHER], NOW);
    }).not.toThrow();
    rejects(() => {
      verifySignature(body, signatureHeader("", T, body), [""], NOW);
    }, "no_matching_signature");
  });

  it("rejects a tampered body, a wrong secret and a length-mismatched signature", () => {
    expect.hasAssertions();
    const header = signatureHeader(SECRET, T, body);
    rejects(() => {
      verifySignature(`${body} `, header, [SECRET], NOW);
    }, "no_matching_signature");
    rejects(() => {
      verifySignature(body, header, [OTHER], NOW);
    }, "no_matching_signature");
    rejects(() => {
      verifySignature(body, `t=${String(T)},v1=${signPayload(SECRET, T, body).slice(0, 63)}`, [SECRET], NOW);
    }, "no_matching_signature");
  });

  it("allows ±300 s and no more", () => {
    const header = signatureHeader(SECRET, T, body);
    for (const skew of [-300, 300]) {
      expect(() => {
        verifySignature(body, header, [SECRET], new Date((T + skew) * 1000));
      }).not.toThrow();
    }
    for (const skew of [-301, 301]) {
      rejects(() => {
        verifySignature(body, header, [SECRET], new Date((T + skew) * 1000));
      }, "timestamp_out_of_tolerance");
    }
  });

  it.each([
    [null, "missing_header"],
    ["  ", "missing_header"],
    [`v1=${"a".repeat(64)}`, "malformed_header"],
    [`t=${String(T)}`, "malformed_header"],
    [`t=${String(T)},v0=${"a".repeat(64)}`, "malformed_header"],
    [`t=abc,v1=${"a".repeat(64)}`, "malformed_header"],
    [`t=${String(T)},v1=${"a".repeat(5000)}`, "malformed_header"],
    ["garbage", "malformed_header"],
  ])("rejects header %j (%s)", (header, reason) => {
    expect.hasAssertions();
    rejects(() => {
      verifySignature(body, header, [SECRET], NOW);
    }, reason);
  });
});

describe("event parsing", () => {
  it("reads the minimal shape: ids, type, time, customer and the account hint", () => {
    expect(verifyWebhookBody(body, signatureHeader(SECRET, T, body), [SECRET], NOW, false)).toEqual({
      id: "evt_1",
      type: "invoice.paid",
      createdAt: new Date((T - 5) * 1000),
      livemode: false,
      customerId: "cus_1",
      objectId: "in_1",
      paymentIntentId: null,
      chargeId: null,
      accountIdHint: ACCOUNT,
    });
  });

  it("a dispute event (the processor's shape: a payment, no customer) exposes its payment references", () => {
    const dispute = JSON.stringify({
      id: "evt_5",
      type: "charge.dispute.closed",
      created: T,
      livemode: false,
      data: {
        object: { id: "dp_9", object: "dispute", charge: "ch_9", payment_intent: "pi_9", status: "lost", metadata: {} },
      },
    });
    expect(parseEvent(dispute, false)).toMatchObject({
      objectId: "dp_9",
      customerId: null,
      paymentIntentId: "pi_9",
      chargeId: "ch_9",
    });
    const charge = JSON.stringify({
      id: "evt_6",
      type: "charge.refunded",
      created: T,
      livemode: false,
      data: { object: { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: { id: "pi_1" } } },
    });
    expect(parseEvent(charge, false)).toMatchObject({ customerId: "cus_1", paymentIntentId: "pi_1", chargeId: "ch_1" });
  });

  it("a customer event's customer is the object itself; an expanded customer gives its id; the reference is a hint", () => {
    const customerEvent = JSON.stringify({
      id: "evt_2",
      type: "customer.deleted",
      created: T,
      livemode: true,
      data: { object: { id: "cus_9", object: "customer", metadata: {} } },
    });
    expect(parseEvent(customerEvent, true)).toMatchObject({ customerId: "cus_9", accountIdHint: null });
    const checkout = JSON.stringify({
      id: "evt_3",
      type: "checkout.session.completed",
      created: T,
      livemode: false,
      data: { object: { id: "cs_1", customer: { id: "cus_2" }, client_reference_id: ACCOUNT.toUpperCase() } },
    });
    expect(parseEvent(checkout, false)).toMatchObject({ customerId: "cus_2", accountIdHint: ACCOUNT });
    const noCustomer = JSON.stringify({
      id: "evt_4",
      type: "charge.dispute.created",
      created: T,
      livemode: false,
      data: { object: { id: "dp_1", customer: null, metadata: { account_id: "not-a-uuid" } } },
    });
    expect(parseEvent(noCustomer, false)).toMatchObject({ customerId: null, accountIdHint: null });
  });

  it("rejects a mode mismatch and malformed bodies", () => {
    expect.hasAssertions();
    rejects(() => parseEvent(body, true), "livemode_mismatch");
    rejects(() => parseEvent("{not json", false), "malformed_event");
    rejects(() => parseEvent(JSON.stringify({ id: "evt" }), false), "malformed_event");
    rejects(
      () =>
        parseEvent(
          JSON.stringify({ id: "", type: "x", created: 1, livemode: false, data: { object: { id: "a" } } }),
          false,
        ),
      "malformed_event",
    );
  });
});

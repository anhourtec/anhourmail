// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The few test-mode-only calls the live suite needs beside our adapter (ADR-0029 §10): test clocks, customers on a
 * clock, test payment methods, subscriptions made directly (the hosted checkout needs a browser), paying an open invoice
 * and dispute evidence. Plain `fetch` at the adapter's pinned API version, like the adapter itself; responses are read
 * only for the fields the suite asserts on. Test mode only (`live-env.ts` refuses a live key before this is used).
 */
import { encodeForm, type FormValue, STRIPE_API_BASE, STRIPE_API_VERSION } from "@anhourmail/adapters/billing-stripe";

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export class TestMode {
  constructor(private readonly key: string) {}

  async call(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, FormValue> = {}): Promise<Json> {
    const form = encodeForm(params);
    const url = method === "POST" || form === "" ? `${STRIPE_API_BASE}${path}` : `${STRIPE_API_BASE}${path}?${form}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method === "POST" ? { body: form } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = isRecord(body) && isRecord(body.error) ? body.error : {};
      const text = (v: unknown) => (typeof v === "string" ? v : "");
      throw new Error(`${method} ${path}: ${String(res.status)} ${text(err.code)} ${text(err.message)}`);
    }
    return isRecord(body) ? body : {};
  }

  /** A test clock frozen at `at`. */
  async clock(at: Date, name: string): Promise<string> {
    const c = await this.call("POST", "/test_helpers/test_clocks", {
      frozen_time: Math.floor(at.getTime() / 1000),
      name,
    });
    return String(c.id);
  }

  /** Moves the clock to `to` and waits until the processor has finished everything that fell due. */
  async advance(clockId: string, to: Date, timeoutMs = 240_000): Promise<void> {
    await this.call("POST", `/test_helpers/test_clocks/${clockId}/advance`, {
      frozen_time: Math.floor(to.getTime() / 1000),
    });
    await this.until(
      async () => (await this.call("GET", `/test_helpers/test_clocks/${clockId}`)).status === "ready",
      timeoutMs,
    );
  }

  async frozenTime(clockId: string): Promise<Date> {
    return new Date(Number((await this.call("GET", `/test_helpers/test_clocks/${clockId}`)).frozen_time) * 1000);
  }

  async deleteClock(clockId: string): Promise<void> {
    await this.call("DELETE", `/test_helpers/test_clocks/${clockId}`).catch(() => undefined);
  }

  /** A customer on the clock, with our account id in its metadata (as our checkout makes it) and a payment method. */
  async customer(clockId: string, accountId: string, paymentMethod: string): Promise<string> {
    const c = await this.call("POST", "/customers", {
      test_clock: clockId,
      email: `billing-live+${accountId.slice(0, 8)}@example.com`,
      metadata: { account_id: accountId },
    });
    const id = String(c.id);
    await this.usePaymentMethod(id, paymentMethod);
    return id;
  }

  /** Attaches a test payment method (`pm_card_visa`, `pm_card_chargeCustomerFail`, …) and makes it the default. */
  async usePaymentMethod(customerId: string, paymentMethod: string): Promise<void> {
    const pm = await this.call("POST", `/payment_methods/${paymentMethod}/attach`, { customer: customerId });
    await this.call("POST", `/customers/${customerId}`, {
      invoice_settings: { default_payment_method: String(pm.id) },
    });
  }

  /** A yearly subscription made directly (what a completed checkout leaves behind), tax-exclusive prices. */
  async subscribe(
    customerId: string,
    accountId: string,
    items: Record<string, FormValue>[],
    extra: Record<string, FormValue> = {},
  ): Promise<Json> {
    return this.call("POST", "/subscriptions", {
      customer: customerId,
      items,
      metadata: { account_id: accountId },
      expand: ["latest_invoice"],
      ...extra,
    });
  }

  /** An invoice's status and collection state (`next_payment_attempt` null = no further automatic attempt). */
  async invoice(invoiceId: string): Promise<{ status: string; nextAttempt: number | null; attempts: number }> {
    const inv = await this.call("GET", `/invoices/${invoiceId}`);
    return {
      status: typeof inv.status === "string" ? inv.status : "",
      nextAttempt: typeof inv.next_payment_attempt === "number" ? inv.next_payment_attempt : null,
      attempts: typeof inv.attempt_count === "number" ? inv.attempt_count : 0,
    };
  }

  async payInvoice(invoiceId: string): Promise<void> {
    await this.call("POST", `/invoices/${invoiceId}/pay`);
  }

  /**
   * The payment intent that paid an invoice: at the pinned version an invoice names its payments, not a payment intent
   * (the adapter reads them the same way).
   */
  async invoicePaymentIntent(invoiceId: string): Promise<string | null> {
    const list = await this.call("GET", "/invoice_payments", { invoice: invoiceId, limit: 10 });
    for (const p of Array.isArray(list.data) ? list.data.filter(isRecord) : []) {
      const pay = isRecord(p.payment) ? p.payment : {};
      if (typeof pay.payment_intent === "string") return pay.payment_intent;
    }
    return null;
  }

  /** The disputes on a payment (dispute objects as the processor returns them). */
  async disputesOf(paymentIntentId: string): Promise<Json[]> {
    const list = await this.call("GET", "/disputes", { payment_intent: paymentIntentId, limit: 10 });
    return Array.isArray(list.data) ? list.data.filter(isRecord) : [];
  }

  /** Test-mode evidence decides a dispute: `winning_evidence` or `losing_evidence` (the processor's test values). */
  async decideDispute(disputeId: string, outcome: "winning_evidence" | "losing_evidence"): Promise<void> {
    await this.call("POST", `/disputes/${disputeId}`, { evidence: { uncategorized_text: outcome }, submit: true });
  }

  /** Polls until `ok` (the processor finishes some work asynchronously). */
  async until(ok: () => Promise<boolean>, timeoutMs = 120_000, everyMs = 2_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await ok()) return;
      if (Date.now() > end) throw new Error("timed out waiting for the payment processor");
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { BillingProviderError } from "@anhourmail/core/billing";
import { setLogSinkForTests } from "@anhourmail/server/log";

import { STRIPE_API_VERSION, stripeHttp } from "./http";
import { stubFetch } from "./stub-fetch";

const KEY = "rk_test_0000example";
const ok = z.object({ id: z.string() });

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  setLogSinkForTests((l) => lines.push(l));
});
afterEach(() => {
  setLogSinkForTests(null);
});

const client = (routes: Parameters<typeof stubFetch>[0]) => {
  const stub = stubFetch(routes);
  const sleeps: number[] = [];
  const http = stripeHttp({
    secretKey: KEY,
    fetch: stub.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { http, calls: stub.calls, sleeps };
};

const code = (c: string) => expect.objectContaining({ code: c }) as BillingProviderError;

describe("processor HTTP client", () => {
  it("sends the key, the pinned version, the idempotency key and a form body", async () => {
    const { http, calls } = client({ "POST /customers": { json: { id: "cus_1" } } });
    expect(await http.post("/customers", { metadata: { account_id: "a" } }, "idem-1", ok)).toEqual({ id: "cus_1" });
    const req = calls[0];
    expect(req?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req?.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(req?.headers.get("idempotency-key")).toBe("idem-1");
    expect(req?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(req?.body.get("metadata[account_id]")).toBe("a");
  });

  it("GET carries a query (expand[] repeated) and no idempotency key; DELETE has no body", async () => {
    const { http, calls } = client({
      "GET /subscriptions": { json: { id: "x" } },
      "DELETE /subscriptions/sub_1": { json: { id: "sub_1" } },
    });
    await http.get("/subscriptions", { customer: "cus 1", expand: ["a", "b"], skip: undefined }, ok);
    expect(calls[0]?.query.getAll("expand[]")).toEqual(["a", "b"]);
    expect(calls[0]?.query.get("customer")).toBe("cus 1");
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
    await http.del("/subscriptions/sub_1", ok);
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.headers.get("content-type")).toBeNull();
  });

  it("retries twice with jittered backoff on 5xx and 429, then succeeds", async () => {
    const { http, calls, sleeps } = client({
      "GET /x": [{ status: 500 }, { status: 429 }, { json: { id: "ok" } }],
    });
    expect(await http.get("/x", {}, ok)).toEqual({ id: "ok" });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("gives up after two retries: 5xx → unavailable, 429 → rate_limited", async () => {
    const down = client({ "GET /x": { status: 503 } });
    await expect(down.http.get("/x", {}, ok)).rejects.toThrow(code("unavailable"));
    expect(down.calls).toHaveLength(3);
    const limited = client({ "GET /x": { status: 429 } });
    await expect(limited.http.get("/x", {}, ok)).rejects.toThrow(code("rate_limited"));
  });

  it("retries network errors, then answers unavailable without the error's text", async () => {
    const { http, calls } = client({ "GET /x": new TypeError("fetch failed: secret detail") });
    await expect(http.get("/x", {}, ok)).rejects.toThrow(code("unavailable"));
    expect(calls).toHaveLength(3);
    expect(lines.join("")).not.toContain("secret detail");
  });

  it("doesn't retry when the processor says not to, nor on 4xx", async () => {
    const noRetry = client({ "POST /x": { status: 500, headers: { "Stripe-Should-Retry": "false" } } });
    await expect(noRetry.http.post("/x", {}, "k", ok)).rejects.toThrow(code("unavailable"));
    expect(noRetry.calls).toHaveLength(1);
    const bad = client({
      "POST /x": {
        status: 400,
        json: { error: { message: "Invalid integer: abc", code: "parameter_invalid_integer" } },
      },
    });
    await expect(bad.http.post("/x", { card: "4242" }, "k", ok)).rejects.toThrow(code("invalid_request"));
    expect(bad.calls).toHaveLength(1);
  });

  it("maps 402, 404, 401 and 403; logs the message only for invalid requests, never bodies or the key", async () => {
    const r = client({
      "POST /declined": { status: 402, json: { error: { type: "card_error", message: "Your card was declined." } } },
      "GET /missing": { status: 404, json: { error: { message: "No such subscription" } } },
      "GET /auth": { status: 401, json: { error: { message: "Invalid API Key provided: rk_test_****" } } },
      "GET /perm": { status: 403, json: {} },
      "POST /bad": { status: 400, json: { error: { message: "No such price: 'price_x'" } } },
      "POST /email": { status: 400, json: { error: { message: "Invalid email address: 'payer2@example.test'" } } },
    });
    await expect(r.http.post("/declined", { email: "payer@example.test" }, "k", ok)).rejects.toThrow(
      code("card_declined"),
    );
    await expect(r.http.get("/missing", {}, ok)).rejects.toThrow(code("not_found"));
    await expect(r.http.get("/auth", {}, ok)).rejects.toThrow(code("unavailable"));
    await expect(r.http.get("/perm", {}, ok)).rejects.toThrow(code("unavailable"));
    await expect(r.http.post("/bad", { email: "payer@example.test" }, "k", ok)).rejects.toThrow(
      code("invalid_request"),
    );
    await expect(r.http.post("/email", {}, "k", ok)).rejects.toThrow(code("invalid_request"));
    const all = lines.join("\n");
    expect(all).toContain("Invalid email address: '[email]'");
    expect(all).not.toContain("payer2@example.test");
    expect(all).toContain("No such price");
    expect(all).not.toContain("Invalid API Key");
    expect(all).not.toContain("payer@example.test");
    expect(all).not.toContain(KEY);
  });

  it("an unexpected or unreadable response is the processor's problem (unavailable), with field paths only", async () => {
    const shape = client({ "GET /x": { json: { id: 42, email: "payer@example.test" } } });
    await expect(shape.http.get("/x", {}, ok)).rejects.toThrow(code("unavailable"));
    expect(lines.join("")).toContain('"path":"id"');
    expect(lines.join("")).not.toContain("payer@example.test");
    const text = stripeHttp({
      secretKey: KEY,
      fetch: async () => new Response("<html>", { status: 200 }),
    });
    await expect(text.get("/x", {}, ok)).rejects.toThrow(code("unavailable"));
    const errText = stripeHttp({
      secretKey: KEY,
      fetch: async () => new Response("oops", { status: 400 }),
    });
    await expect(errText.get("/x", {}, ok)).rejects.toThrow(code("invalid_request"));
  });

  it("every request has a timeout and refuses redirects", async () => {
    let init: RequestInit | undefined;
    const http = stripeHttp({
      secretKey: KEY,
      fetch: async (_url, i) => {
        init = i;
        return Response.json({ id: "x" });
      },
    });
    await http.get("/x", {}, ok);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
  });
});

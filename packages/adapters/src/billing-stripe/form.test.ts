// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { encodeForm } from "./form";

const decoded = (s: string) => decodeURIComponent(s);

describe("form encoding (the processor's documented nesting)", () => {
  it("indexes lists of objects and brackets nested keys", () => {
    expect(
      decoded(
        encodeForm({
          items: [
            { price: "price_123", quantity: 2 },
            { id: "si_1", deleted: true },
          ],
          metadata: { account_id: "acc-1" },
        }),
      ),
    ).toBe(
      "items[0][price]=price_123&items[0][quantity]=2&items[1][id]=si_1&items[1][deleted]=true&metadata[account_id]=acc-1",
    );
  });

  it("deep inline prices", () => {
    expect(
      decoded(
        encodeForm({
          line_items: [
            { price_data: { currency: "usd", unit_amount: 5000, recurring: { interval: "year" } }, quantity: 1 },
          ],
        }),
      ),
    ).toBe(
      "line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=5000&line_items[0][price_data][recurring][interval]=year&line_items[0][quantity]=1",
    );
  });

  it("`expand` lists are unindexed, booleans are words, null and undefined are left out", () => {
    expect(encodeForm({ expand: ["latest_invoice", "customer"], a: false, b: null, c: undefined })).toBe(
      "expand[]=latest_invoice&expand[]=customer&a=false",
    );
  });

  it("percent-encodes values and keys but keeps the brackets readable", () => {
    expect(encodeForm({ success_url: "https://app.example/x?a=1&b=2", "we ird": "é" })).toBe(
      "success_url=https%3A%2F%2Fapp.example%2Fx%3Fa%3D1%26b%3D2&we%20ird=%C3%A9",
    );
  });
});

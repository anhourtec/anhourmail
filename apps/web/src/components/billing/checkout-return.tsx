// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { StatusText } from "../console/status-text";

/**
 * Back from the payment page. `done`: the payment is confirmed by the processor's signed notice and our sync, usually
 * within seconds, so the page refreshes every few seconds (for up to a minute) until the plan shows. `cancelled`:
 * nothing was charged.
 */
export function CheckoutReturn({ outcome, settled }: { outcome: "done" | "cancelled"; settled: boolean }) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (outcome !== "done" || settled) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (tries > 20) {
        window.clearInterval(timer);
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [outcome, settled, router]);

  if (outcome === "cancelled") {
    return (
      <p role="status" className="rounded-lg border px-4 py-3">
        <StatusText tone="neutral">Checkout cancelled. Nothing was charged.</StatusText>
      </p>
    );
  }
  return (
    <p role="status" className="rounded-lg border px-4 py-3">
      {settled ? (
        <StatusText tone="success">Thank you. Your plan is active.</StatusText>
      ) : gaveUp ? (
        <StatusText tone="info">
          Your payment is still being confirmed. Reload this page in a few minutes; you won&apos;t be charged twice.
        </StatusText>
      ) : (
        <StatusText tone="info">Payment received. Confirming it with the payment processor…</StatusText>
      )}
    </p>
  );
}

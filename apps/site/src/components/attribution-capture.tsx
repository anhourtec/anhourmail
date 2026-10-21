// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect } from "react";

import { captureAttribution } from "@/lib/attribution";

/** Records UTM/ref from the landing URL into sessionStorage (no cookies, no network). Renders nothing. */
export function AttributionCapture() {
  useEffect(() => {
    captureAttribution(window.location.search);
  }, []);
  return null;
}

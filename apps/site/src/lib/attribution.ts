// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a visitor came from: UTM parameters and a referral/invite code from the landing URL. Kept in
 * sessionStorage for this tab only (never cookies, never sent anywhere but the waitlist form). Values are capped
 * and validated again by the server (WaitlistSignupSchema).
 */
import type { Utm } from "@anhourmail/shared/schemas";

const KEY = "am.attribution";
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;

export type Attribution = { utm?: Utm; ref?: string };

const clean = (v: string | null, max: number): string | undefined => {
  const t = v?.trim();
  return t ? t.slice(0, max) : undefined;
};

export function captureAttribution(search: string): void {
  try {
    const params = new URLSearchParams(search);
    const utm: Utm = {};
    for (const k of UTM_KEYS) {
      const v = clean(params.get(`utm_${k}`), 100);
      if (v) utm[k] = v;
    }
    const refRaw = clean(params.get("ref") ?? params.get("invite"), 32);
    const ref = refRaw && /^[A-Za-z0-9-]{4,32}$/.test(refRaw) ? refRaw : undefined;
    if (Object.keys(utm).length === 0 && !ref) return;
    // First touch wins within a tab session.
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...(Object.keys(utm).length ? { utm } : {}), ...(ref ? { ref } : {}) }),
    );
  } catch {
    // Storage blocked (private mode): attribution is optional.
  }
}

export function readAttribution(): Attribution {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Attribution;
    return typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

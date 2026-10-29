// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

/**
 * A person's (or a shared mailbox's) photo with initials as the fallback (ADR-0022). `src` is only ever one of our
 * own same-origin photo URLs (`/api/avatars/…` on the console, `/api/webmail/avatars/…` in the webmail), carrying the
 * photo's version, so a change shows as a new URL and an unchanged photo comes from the browser's cache. A photo that
 * fails to load (removed meanwhile, signed out) falls back to the initials. Decorative: the name is always next to it.
 */
export function PersonPhoto({ src, label, className }: { src?: string | null; label: string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- our own small same-origin photo, already re-encoded and versioned; the image optimiser would only add a second copy
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        decoding="async"
        onError={() => {
          setFailed(src);
        }}
        className={`${className} object-cover`}
      />
    );
  }
  return (
    <span aria-hidden className={className}>
      {label}
    </span>
  );
}

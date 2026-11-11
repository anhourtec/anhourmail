// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pausing what a managed Sieve script sends while a mailbox's trust tier doesn't allow it (ADR-0034 §3 and update
 * 2026-11-11 "Forwarding and automatic replies under a tier"). The mail server's send block doesn't stop a script's
 * `redirect` or `vacation` (research/stalwart.md "Billing access states"), so the script itself must:
 *
 * - `restricted` → every `redirect` and `vacation` is paused;
 * - `new` → only `redirect`s to addresses we don't host (the external hold); internal forwarding and replies run;
 * - `standard`, `trusted` → nothing is paused.
 *
 * A paused command stays in the script, wrapped in `if false { … }` after a fixed marker, so lifting the pause gives
 * back exactly what the person set (the settings line is never touched, and nothing needs their contacts). The
 * transform only ever touches code — never text inside a string or a comment, so a reply text that looks like the
 * marker changes nothing. Pure text in, text out: the web app writes it (it alone holds the key that writes Sieve,
 * ADR-0020) and the reconciler reads it.
 */
import type { TrustTier } from "@anhourmail/shared/sending";

export type SendingPauseMode = "none" | "external" | "all";

/** What a mailbox's managed script may send, by its effective tier. */
export function pauseModeFor(tier: TrustTier): SendingPauseMode {
  if (tier === "restricted") return "all";
  if (tier === "new") return "external";
  return "none";
}

/** The opening of a paused command (its own line, before the command). Never change it: scripts carry it. */
export const PAUSE_OPEN = "if false { # AnhourMail: paused while this mailbox can't send there\n";
const PAUSE_CLOSE = "\n}";

/** A `redirect` or `vacation` command in code: where it starts and ends (after its `;`), and a redirect's target. */
export type OutboundCommand = {
  kind: "redirect" | "vacation";
  start: number;
  end: number;
  /** The redirect's target, lowercased; null for `vacation` or a target that isn't one plain string. */
  target: string | null;
  /** Inside the pause wrapper. */
  paused: boolean;
};

/** Which characters are code (not inside a string or a comment). */
function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (/^text:/i.test(text.slice(i, i + 5))) {
      const end = text.indexOf("\n.\n", i);
      i = end === -1 ? text.length : end + 3;
    } else {
      mask[i] = 1;
      i += 1;
    }
  }
  return mask;
}

/** The quoted string starting at `at` (decoded) and the index after it, or null. */
function quotedAt(text: string, at: number): { value: string; next: number } | null {
  if (text[at] !== '"') return null;
  let value = "";
  let i = at + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === "\\" && i + 1 < text.length) i += 1;
    value += text[i] ?? "";
    i += 1;
  }
  return i < text.length ? { value, next: i + 1 } : null;
}

const WORD = /[A-Za-z0-9_]/;

/** Every `redirect` and `vacation` command in the script's code, in order. */
export function outboundCommands(text: string): OutboundCommand[] {
  const mask = codeMask(text);
  const out: OutboundCommand[] = [];
  for (const kind of ["redirect", "vacation"] as const) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(kind, from);
      if (at === -1) break;
      from = at + kind.length;
      const before = at === 0 ? "" : (text[at - 1] ?? "");
      const after = text[at + kind.length] ?? "";
      if (mask[at] !== 1 || WORD.test(before) || WORD.test(after)) continue;
      // Its end: the first `;` in code after it.
      let end = at + kind.length;
      while (end < text.length && !(text[end] === ";" && mask[end] === 1)) end += 1;
      if (end >= text.length) continue;
      let target: string | null = null;
      if (kind === "redirect") {
        const args = /^\s+(?::copy\s+)?/.exec(text.slice(at + kind.length, end));
        const q = args ? quotedAt(text, at + kind.length + args[0].length) : null;
        target = q && /^\s*$/.test(text.slice(q.next, end)) ? q.value.trim().toLowerCase() : null;
      }
      const paused =
        at >= PAUSE_OPEN.length &&
        text.slice(at - PAUSE_OPEN.length, at) === PAUSE_OPEN &&
        mask[at - PAUSE_OPEN.length] === 1 &&
        text.startsWith(PAUSE_CLOSE, end + 1);
      out.push({ kind, start: at, end: end + 1, target, paused });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The script with every pause lifted: exactly what was written before any pause. */
export function liftSendingPause(text: string): string {
  let out = text;
  for (const c of outboundCommands(text).reverse()) {
    if (!c.paused) continue;
    out = out.slice(0, c.start - PAUSE_OPEN.length) + out.slice(c.start, c.end) + out.slice(c.end + PAUSE_CLOSE.length);
  }
  return out;
}

/**
 * The script with the pause for `mode` applied (any earlier pause is lifted first, so moving between tiers is exact).
 * `outside(address)`: whether a redirect target is outside the addresses we host (for `external`). A redirect whose
 * target can't be read is treated as outside.
 */
export function applySendingPause(text: string, mode: SendingPauseMode, outside: (address: string) => boolean): string {
  const base = liftSendingPause(text);
  if (mode === "none") return base;
  let out = base;
  for (const c of outboundCommands(base).reverse()) {
    const pause = mode === "all" || (c.kind === "redirect" && (c.target === null || outside(c.target)));
    if (!pause) continue;
    out = `${out.slice(0, c.start)}${PAUSE_OPEN}${out.slice(c.start, c.end)}${PAUSE_CLOSE}${out.slice(c.end)}`;
  }
  return out;
}

/** The redirect targets (lowercased, once each) a script names, paused or not: what `outside` must answer for. */
export function redirectTargets(text: string): string[] {
  return [
    ...new Set(
      outboundCommands(text)
        .map((c) => c.target)
        .filter((t): t is string => t !== null),
    ),
  ];
}

/**
 * What runs that the mode doesn't allow (the reconciler's check): commands not paused that `applySendingPause` would
 * pause. Zero when the script is as the tier wants it.
 */
export function unpausedOutbound(text: string, mode: SendingPauseMode, outside: (address: string) => boolean): number {
  if (mode === "none") return 0;
  return outboundCommands(text).filter(
    (c) => !c.paused && (mode === "all" || (c.kind === "redirect" && (c.target === null || outside(c.target)))),
  ).length;
}

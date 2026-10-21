// SPDX-License-Identifier: AGPL-3.0-only
/** Shared control classes for console forms (tokens only, CLAUDE.md conventions). */
export const inputClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-[15px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";

export const primaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 font-medium text-[15px] text-primary-foreground transition-opacity disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-4 text-[15px] transition-colors hover:bg-accent disabled:opacity-60";

export const dangerButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-destructive/40 px-4 text-[15px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60";

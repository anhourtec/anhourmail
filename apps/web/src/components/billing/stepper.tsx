// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Minus, Plus } from "lucide-react";
import { useId } from "react";

/** A whole-number field with − and + buttons, from 0 to `max` (add-on quantities). */
export function Stepper({
  label,
  value,
  max,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const set = (n: number) => {
    onChange(Math.min(max, Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0)));
  };
  const button =
    "inline-flex size-10 shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-accent disabled:opacity-50";
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="am-small text-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Fewer: ${label}`}
          disabled={disabled || value <= 0}
          onClick={() => {
            set(value - 1);
          }}
          className={button}
        >
          <Minus className="size-4" aria-hidden />
        </button>
        <input
          id={id}
          inputMode="numeric"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => {
            set(Number(e.target.value.replace(/\D/g, "")));
          }}
          className="am-num h-10 w-16 rounded-lg border bg-background px-2 text-center text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          aria-label={`More: ${label}`}
          disabled={disabled || value >= max}
          onClick={() => {
            set(value + 1);
          }}
          className={button}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

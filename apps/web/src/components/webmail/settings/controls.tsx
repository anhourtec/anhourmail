// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Info } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId } from "react";

/**
 * Small, dependency-free controls for the settings window: a titled group, a setting row (label and description on
 * the left, the control on the right; stacked on phones), a segmented single choice (radio group with arrow keys),
 * a switch, a native select and an informational note. Tokens only.
 */

export function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h3 id={id} className="font-medium text-[14px]">
        {title}
      </h3>
      {description && <p className="am-small max-w-prose">{description}</p>}
      <div className="mt-2 flex flex-col divide-y rounded-xl border">{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  htmlFor,
  labelId,
  children,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className="text-[14px]">
            {label}
          </label>
        ) : (
          <span id={labelId} className="text-[14px]">
            {label}
          </span>
        )}
        {description && <span className="am-micro max-w-prose">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** One of a few options, as a segmented control (role radiogroup; arrow keys move and choose). */
export function Choice<T extends string | number>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const group = e.currentTarget.parentElement;
    const buttons = group ? Array.from(group.querySelectorAll<HTMLButtonElement>("[role=radio]")) : [];
    buttons[(i + step + options.length) % options.length]?.focus();
  };
  return (
    <Row label={label} description={description} labelId={id}>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="inline-flex flex-wrap gap-0.5 rounded-lg border bg-muted/60 p-0.5"
      >
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onKeyDown={(e) => {
                onKey(e, i);
              }}
              onClick={() => {
                onChange(o.value);
              }}
              className={`h-8 rounded-md px-3 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                on
                  ? "bg-background font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </Row>
  );
}

/** An on/off switch (role switch). */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Row label={label} description={description} htmlFor={id}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:opacity-50 ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-5 rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-[1.125rem]" : "translate-x-0.5"}`}
        />
      </button>
    </Row>
  );
}

export function SelectRow<T extends string | number>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <Row label={label} description={description} htmlFor={id}>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) onChange(picked.value);
        }}
        className="h-9 w-full max-w-64 rounded-lg border bg-background px-2.5 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-60"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** A fact about how something works, with no control (e.g. "Remote images are always blocked"). */
export function Note({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px]">{label}</span>
        <span className="am-micro max-w-prose">{children}</span>
      </div>
    </div>
  );
}

export const fieldClass =
  "h-9 w-full rounded-lg border bg-background px-3 text-[14px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";
export const areaClass =
  "min-h-28 w-full resize-y rounded-lg border bg-background px-3 py-2 text-[14px] leading-6 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring";
export const smallPrimary =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 font-medium text-[14px] text-primary-foreground transition-opacity disabled:opacity-60";
export const smallSecondary =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3.5 text-[14px] transition-colors hover:bg-accent disabled:opacity-60";

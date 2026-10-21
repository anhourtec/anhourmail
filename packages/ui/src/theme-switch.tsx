// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

/**
 * Light / Dark / System switch, shared by the site, docs, console and webmail (branding.md "Dark mode").
 * A radio group: arrow keys move between options, the selected one is announced.
 */
const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

const noop = () => () => undefined;

export function ThemeSwitch({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  // The stored theme is only known on the client; render "system" on the server to avoid a mismatch.
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const current = mounted ? (theme ?? "system") : "system";
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={`inline-flex h-9 items-center gap-0.5 rounded-lg border p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = current === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => {
              setTheme(value);
            }}
            className={`inline-flex size-7 items-center justify-center rounded-md transition-colors ${
              selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

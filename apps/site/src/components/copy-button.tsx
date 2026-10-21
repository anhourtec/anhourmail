// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { CheckIcon, CopyIcon } from "lucide-react";

/** Icon button that copies `value` to the clipboard. Used on every DNS record and server setting. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [checked, onClick] = useCopyButton(() => navigator.clipboard.writeText(value));
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={checked ? `Copied ${label}` : `Copy ${label}`}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
    >
      {checked ? (
        <CheckIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <CopyIcon className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, Download } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

const noop = () => () => undefined;

/** A date in the reader's own time zone (the server renders UTC until the page hydrates). */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    noop,
    () =>
      new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    () => new Date(iso).toUTCString(),
  );
  return <time dateTime={iso}>{text}</time>;
}

/**
 * "Download original" and "Copy to clipboard" for the Show original page. The copy reads the source from the page's
 * own text block, so the source is never sent to the browser twice.
 */
export function OriginalActions({ downloadHref, sourceId }: { downloadHref: string; sourceId: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={downloadHref} download="message.eml" className={primaryButtonClass}>
        <Download className="size-4" aria-hidden /> Download original
      </a>
      <button
        type="button"
        className={secondaryButtonClass}
        onClick={() => {
          const text = document.getElementById(sourceId)?.textContent ?? "";
          navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied("done");
            })
            .catch(() => {
              setCopied("failed");
            });
        }}
      >
        {copied === "done" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {copied === "done" ? "Copied" : "Copy to clipboard"}
      </button>
      <span role="status" className="am-micro">
        {copied === "failed" ? "Couldn't copy. Select the text and copy it instead." : ""}
      </span>
    </div>
  );
}

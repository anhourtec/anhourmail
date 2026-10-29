// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";

import { AVATAR } from "@anhourmail/shared/profile";

import { PersonPhoto } from "./person-photo";
import { PHOTO_ACCEPT, sendPhoto, squarePhoto } from "./photo-file";

/**
 * Upload, change or remove a profile photo (ADR-0022), for the console (Profile page, a person's or a shared
 * mailbox's panel) and the webmail (Settings → Account → You). The chosen file is cropped to its centred square and
 * re-encoded in the browser, then sent to `endpoint` (POST the image, DELETE to remove), where it is checked and
 * re-encoded again. `onChanged` gets the new URL (null once removed) so the caller refreshes every place that shows it.
 */
export function PhotoEditor({
  url,
  initials,
  endpoint,
  onChanged,
  subject,
  previewClass,
  buttonClass,
}: {
  url: string | null;
  initials: string;
  endpoint: string;
  onChanged: (url: string | null) => void;
  /** Whose photo, for the buttons' accessible names ("your photo", "Sam Lee's photo"). */
  subject: string;
  previewClass: string;
  buttonClass: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const id = useId();

  const run = async (photo: () => Promise<Blob | null>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await sendPhoto(endpoint, await photo());
      if (!res.ok) {
        setStatus({ tone: "error", text: res.message });
        return;
      }
      setStatus({ tone: "ok", text: done });
      onChanged(res.url);
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "Something went wrong. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-4">
      <PersonPhoto src={url} label={initials} className={previewClass} />
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            id={`${id}-file`}
            type="file"
            accept={PHOTO_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void run(() => squarePhoto(file), "Photo saved.");
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            aria-label={url ? `Change ${subject}` : `Upload ${subject}`}
            className={buttonClass}
          >
            <ImageUp className="size-4" aria-hidden /> {url ? "Change photo" : "Upload photo"}
          </button>
          {url && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => Promise.resolve(null), "Photo removed.")}
              aria-label={`Remove ${subject}`}
              className={buttonClass}
            >
              <Trash2 className="size-4" aria-hidden /> Remove
            </button>
          )}
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          PNG, JPEG or WebP, up to <span className="font-mono">{AVATAR.maxUploadMb}</span> MB. We crop it to a square.
        </p>
        <p
          role={status?.tone === "error" ? "alert" : "status"}
          className={`text-[13px] ${status?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {busy ? "Saving…" : (status?.text ?? "")}
        </p>
      </div>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Download, FileArchive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { callApi } from "../api";
import { StatusText, type Tone } from "../console/status-text";
import { StepUpForm } from "../security/step-up-form";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";

/** One export as the page shows it (dates already formatted on the server). */
export type ExportRow = {
  id: string;
  status: "queued" | "building" | "ready" | "failed" | "expired";
  requested: string;
  expires: string | null;
  downloaded: string | null;
  size: string | null;
};

const STATUS: Record<ExportRow["status"], { tone: Tone; label: string }> = {
  queued: { tone: "info", label: "Waiting to be prepared" },
  building: { tone: "info", label: "Being prepared" },
  ready: { tone: "success", label: "Ready to download" },
  failed: { tone: "danger", label: "Couldn't be prepared" },
  expired: { tone: "neutral", label: "Expired and deleted" },
};

/**
 * Ask for an export and download finished ones (ADR-0025). Downloading asks the person to confirm it's them when the
 * server wants a fresh step-up, then saves the ZIP; the archive never sits in the page.
 */
export function ExportPanel({
  endpoint,
  rows,
  keepDays,
}: {
  /** `/api/accounts/:id/exports` or `/api/me/exports`. */
  endpoint: string;
  rows: ExportRow[];
  keepDays: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const [stepUpFor, setStepUpFor] = useState<string | null>(null);
  const waiting = rows.some((r) => r.status === "queued" || r.status === "building");

  async function request() {
    setBusy(true);
    setMessage(null);
    const res = await callApi(endpoint, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setMessage({ tone: "danger", text: res.message });
      return;
    }
    setMessage({
      tone: "success",
      text: "Export requested. We'll email you when it's ready, usually within a few minutes.",
    });
    router.refresh();
  }

  async function download(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${endpoint}/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        if (body?.error?.code === "step_up_required") {
          setStepUpFor(id);
          return;
        }
        setMessage({ tone: "danger", text: body?.error?.message ?? "The download didn't work. Try again." });
        router.refresh();
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export.zip";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 30_000);
      router.refresh();
    } catch {
      setMessage({ tone: "danger", text: "Couldn't reach the server. Check your connection." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void request()} disabled={busy || waiting} className={primaryButtonClass}>
          <FileArchive className="size-4" aria-hidden />
          Request an export
        </button>
        {waiting && (
          <span className="am-small">An export is being prepared. We&apos;ll email you when it&apos;s ready.</span>
        )}
      </div>
      {message && (
        <p role="status">
          <StatusText tone={message.tone}>{message.text}</StatusText>
        </p>
      )}
      {stepUpFor && (
        <StepUpForm
          why="Exports hold your account's data, so we check it's you before each download."
          onConfirmed={async () => {
            const id = stepUpFor;
            setStepUpFor(null);
            await download(id);
          }}
          onCancel={() => {
            setStepUpFor(null);
          }}
        />
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[14px]">
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Requested
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                  Available until
                </th>
                <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                  Size
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono">{r.requested}</td>
                  <td className="px-3 py-2">
                    <StatusText tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusText>
                    {r.downloaded && <span className="am-micro block">Downloaded {r.downloaded}</span>}
                  </td>
                  <td className="hidden px-3 py-2 font-mono sm:table-cell">{r.expires ?? "—"}</td>
                  <td className="hidden px-3 py-2 font-mono sm:table-cell">{r.size ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "ready" && (
                      <button
                        type="button"
                        onClick={() => void download(r.id)}
                        disabled={busy}
                        className={secondaryButtonClass}
                      >
                        <Download className="size-4" aria-hidden />
                        Download
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="am-small max-w-[80ch]">
        A finished export can be downloaded for {String(keepDays)} days, then we delete it. Only you can download the
        exports you ask for.
      </p>
    </div>
  );
}

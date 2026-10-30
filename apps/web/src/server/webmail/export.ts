// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { MAIL_EXPORT_PART_BYTES } from "@anhourmail/shared/data-lifecycle";
import { log } from "@anhourmail/server/log";
import { ZipWriter, zipSegment } from "@anhourmail/server/zip";

import { ownMailbox, WebmailBlockedError, type WebmailService, WebmailRefusedError } from "./service";

/**
 * Mail export from the webmail (ADR-0025 "Mail"): the signed-in mailbox's mail as one `.mbox` file per folder (mboxrd,
 * split into parts at `MAIL_EXPORT_PART_BYTES`) plus its contacts as `contacts.vcf`, in a ZIP streamed straight to the
 * person's browser with the session's own token. Nothing is written to disk, Postgres or logs (rule 24): each message
 * passes through memory once, and the archive exists only in the response. The mailbox is pinned at the start: if the
 * session switches to another mailbox mid-way, the export stops instead of mixing two mailboxes.
 */

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const PAGE = 100;
/** The control plane's access gate is asked again before each folder and after this many messages. */
export const GATE_EVERY = 50;

/** What the export needs of the webmail service (the class itself in the app; a stand-in in unit tests). */
export type ExportSource = Pick<WebmailService, "session" | "jmapAs" | "download" | "exportContacts" | "blockedReason">;

export type MailExportSummary = {
  folders: number;
  messages: number;
  /** Messages the mail server didn't hand over (gone meanwhile, or a refused download). */
  skipped: number;
  contacts: number;
  complete: boolean;
};

type Folder = { id: string; name: string; parentId: string | null; role: string | null };

type JmapBody = { methodResponses?: [string, Record<string, unknown>, string][] } | null;

/** asctime() in UTC for the mbox separator line ("Thu Oct 29 12:00:00 2026"). */
export function asctime(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()] ?? "Mon"} ${months[d.getUTCMonth()] ?? "Jan"} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${String(d.getUTCFullYear())}`;
}

/**
 * One message as an mboxrd entry: the `From ` separator, the source with every line that starts with `>*From ` quoted
 * once more (so readers can undo it exactly), and a blank line. Bytes are kept as they are (latin1 round-trip).
 */
export function mboxEntry(source: Uint8Array, receivedAt: Date): Buffer {
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("latin1");
  const quoted = text.replace(/^(>*From )/gm, ">$1");
  const ending = quoted.endsWith("\n") ? "" : "\n";
  return Buffer.from(`From MAILER-DAEMON ${asctime(receivedAt)}\n${quoted}${ending}\n`, "latin1");
}

/** Archive paths for folders: `mail/Parent/Child.mbox`, each segment made safe, duplicates numbered. */
export function folderPaths(folders: readonly Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = (f: Folder, depth = 0): string[] => {
    const parent = f.parentId ? byId.get(f.parentId) : undefined;
    const own = zipSegment(f.name, "folder");
    return parent && depth < 20 ? [...path(parent, depth + 1), own] : [own];
  };
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const f of folders) {
    const base = `mail/${path(f).join("/")}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${String(n)})`;
    used.add(name.toLowerCase());
    out.set(f.id, name);
  }
  return out;
}

const responses = (body: unknown) =>
  new Map(((body as JmapBody)?.methodResponses ?? []).map(([, args, id]) => [id, args]));

/**
 * Streams the export of the session's active mailbox (all folders, or just `folderId`, which must be one of its
 * folders). `onDone` gets the counts once it finished or stopped (the caller audits them). Throws before the first byte
 * when the session is gone or the folder isn't the mailbox's. A mailbox the control plane blocks meanwhile (suspended,
 * deleted, its account waiting to be deleted) stops the export within `GATE_EVERY` messages: the response ends with an
 * error instead of a finished archive.
 */
export async function mailExportStream(
  svc: ExportSource,
  sessionId: string,
  opts: { folderId?: string },
  onDone: (address: string, summary: MailExportSummary) => Promise<void>,
): Promise<ReadableStream<Uint8Array>> {
  const read = await svc.session(sessionId);
  if (!read) throw new WebmailRefusedError("Sign in again to export this mailbox.");
  // The person's own mailbox only (ADR-0026 §6); every later call refuses a shared one too (the service's default).
  const s = ownMailbox(read);
  const accountId = s.accountId;
  const address = s.username;
  const pinned = (current: { accountId: string }) => {
    if (current.accountId !== accountId)
      throw new WebmailRefusedError("Your active mailbox changed. Start the export again.");
  };
  const call = async (methodCalls: [string, Record<string, unknown>, string][]) =>
    responses(
      await svc.jmapAs(sessionId, (current) => {
        pinned(current);
        return { using: USING, methodCalls };
      }),
    );

  const listed = await call([["Mailbox/get", { accountId, properties: ["id", "name", "parentId", "role"] }, "m"]]);
  const folders = (listed.get("m")?.list ?? []) as Folder[];
  const chosen = opts.folderId === undefined ? folders : folders.filter((f) => f.id === opts.folderId);
  if (chosen.length === 0) throw new WebmailRefusedError("That folder isn't in this mailbox.");
  const paths = folderPaths(folders);

  const summary: MailExportSummary = { folders: 0, messages: 0, skipped: 0, contacts: 0, complete: false };
  const state: { cancelled: boolean; resume: (() => void) | null } = { cancelled: false, resume: null };
  /** Read through a function so checks after an await aren't narrowed away. */
  const cancelled = (): boolean => state.cancelled;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const emit = async (chunk: Uint8Array) => {
          if (state.cancelled) throw new Error("export cancelled");
          controller.enqueue(chunk);
          while ((controller.desiredSize ?? 1) <= 0 && !cancelled()) {
            await new Promise<void>((resolve) => {
              state.resume = resolve;
            });
          }
        };
        const zip = new ZipWriter(emit);
        let sinceGate = 0;
        const gate = async () => {
          sinceGate = 0;
          if ((await svc.blockedReason(address)) !== null) throw new WebmailBlockedError("mailbox unavailable");
        };
        const run = async () => {
          const started = new Date();
          for (const f of chosen) {
            await gate();
            const base = paths.get(f.id) ?? `mail/${zipSegment(f.name, "folder")}`;
            let part = 1;
            await zip.begin(`${base}.mbox`, started);
            for (let position = 0; ; position += PAGE) {
              const r = await call([
                [
                  "Email/query",
                  {
                    accountId,
                    filter: { inMailbox: f.id },
                    sort: [{ property: "receivedAt", isAscending: true }],
                    position,
                    limit: PAGE,
                  },
                  "q",
                ],
                [
                  "Email/get",
                  {
                    accountId,
                    "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
                    properties: ["id", "blobId", "receivedAt", "size"],
                  },
                  "g",
                ],
              ]);
              const page = (r.get("g")?.list ?? []) as { blobId: string; receivedAt: string; size: number }[];
              for (const e of page) {
                const res = await svc.download(sessionId, accountId, e.blobId, "message.eml");
                if (!res.ok) {
                  await res.body?.cancel();
                  summary.skipped += 1;
                  continue;
                }
                const entry = mboxEntry(new Uint8Array(await res.arrayBuffer()), new Date(e.receivedAt));
                if (zip.entrySize > 0 && zip.entrySize + entry.length > MAIL_EXPORT_PART_BYTES) {
                  part += 1;
                  await zip.begin(`${base}-${String(part)}.mbox`, started);
                }
                await zip.write(entry);
                await zip.flush();
                summary.messages += 1;
                sinceGate += 1;
                if (sinceGate >= GATE_EVERY) await gate();
              }
              if (page.length < PAGE) break;
            }
            await zip.end();
            summary.folders += 1;
          }
          if (opts.folderId === undefined) {
            await gate();
            const vcf = await svc.exportContacts(sessionId);
            // The contacts came from the active mailbox: make sure it's still the one being exported.
            pinned((await svc.session(sessionId)) ?? { accountId: "" });
            summary.contacts = (vcf.match(/^BEGIN:VCARD/gim) ?? []).length;
            await zip.begin("contacts.vcf", started);
            await zip.write(vcf);
            await zip.end();
          }
          await zip.begin("README.txt", started);
          await zip.write(
            [
              "AnhourMail mail export",
              "",
              `Mailbox: ${address}`,
              `Exported: ${started.toISOString()}`,
              `Folders: ${String(summary.folders)}  Messages: ${String(summary.messages)}${summary.skipped > 0 ? `  Skipped: ${String(summary.skipped)}` : ""}`,
              "",
              "mail/<folder>.mbox  one file per folder (mboxrd); most mail apps can import these",
              opts.folderId === undefined ? "contacts.vcf        your contacts (vCard)" : "",
              "",
            ].join("\n"),
          );
          await zip.finish();
          summary.complete = true;
        };
        run()
          .then(() => {
            controller.close();
          })
          .catch((err: unknown) => {
            if (!state.cancelled) {
              log.warn("webmail mail export stopped", {
                component: "webmail",
                errorName: err instanceof Error ? err.name : "unknown",
              });
              controller.error(err);
            }
          })
          .finally(() => {
            onDone(address, summary).catch(() => undefined);
          });
      },
      pull() {
        state.resume?.();
        state.resume = null;
      },
      cancel() {
        state.cancelled = true;
        state.resume?.();
        state.resume = null;
      },
    },
    { highWaterMark: 16 },
  );
}

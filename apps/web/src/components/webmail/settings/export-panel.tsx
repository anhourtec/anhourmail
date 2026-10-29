// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Download } from "lucide-react";

import { folderLabel, folderTree } from "../format";
import type { Folder } from "../mail-client";
import { Group, Note, smallPrimary, smallSecondary } from "./controls";

/**
 * Settings → Export (ADR-0025): this mailbox's mail as one `.mbox` file per folder plus its contacts, in a ZIP the
 * browser downloads straight from the server (a plain link, so nothing is held in the page). One folder at a time is
 * there for very large mailboxes, or to pick up where a download stopped.
 */
export function ExportPanel({ folders }: { folders: Folder[] }) {
  const nodes = folderTree(folders);
  return (
    <div className="flex flex-col gap-6">
      <Group
        title="Export this mailbox"
        description="Every folder as an mbox file (most mail apps can import them) and your contacts as a vCard file, in one ZIP. It's made as it downloads and never stored by us."
      >
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <a href="/api/webmail/export" download className={smallPrimary}>
            <Download className="size-4" aria-hidden />
            Download all mail and contacts
          </a>
        </div>
        <Note label="Large mailboxes take a while">
          Keep this tab open until the download finishes. If it stops, download the remaining folders one by one below.
        </Note>
      </Group>
      <Group title="One folder at a time">
        <ul className="flex flex-col">
          {nodes.map((n) => (
            <li
              key={n.folder.id}
              className="flex items-center justify-between gap-3 border-t px-4 py-2 first:border-t-0"
            >
              <span className="min-w-0 truncate text-[14px]" style={{ paddingLeft: `${String(n.depth * 16)}px` }}>
                {folderLabel(n.folder)}
                <span className="am-micro ml-2 font-mono">{String(n.folder.totalEmails)}</span>
              </span>
              <a
                href={`/api/webmail/export?folder=${encodeURIComponent(n.folder.id)}`}
                download
                className={smallSecondary}
                aria-label={`Download ${folderLabel(n.folder)}`}
              >
                <Download className="size-4" aria-hidden />
                Download
              </a>
            </li>
          ))}
        </ul>
      </Group>
    </div>
  );
}

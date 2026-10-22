// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  FilePen,
  Folder as FolderIcon,
  Inbox,
  LogOut,
  type LucideIcon,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { FolderTreeSkeleton } from "@anhourmail/ui/skeletons";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/theme-toggle";

import { folderLabel, folderTree } from "./format";
import type { Folder } from "./mail-client";

const ROLE_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  drafts: FilePen,
  sent: Send,
  archive: Archive,
  junk: ShieldAlert,
  trash: Trash2,
};

/** Folder navigation with unread counts (Drafts shows its total), then the signed-in mailbox and sign-out. */
export function FolderSidebar({
  folders,
  currentId,
  username,
  onSelect,
  onSignOut,
}: {
  folders: Folder[] | null;
  currentId: string | null;
  username: string;
  onSelect: (id: string) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-4">
        <BrandMark area="Webmail" />
      </div>
      <nav aria-label="Folders" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {folders === null ? (
          <FolderTreeSkeleton folders={8} />
        ) : (
          <ul className="flex flex-col gap-0.5 pt-1">
            {folderTree(folders).map(({ folder, depth }) => {
              const Icon = (folder.role ? ROLE_ICON[folder.role] : undefined) ?? FolderIcon;
              const current = folder.id === currentId;
              const count = folder.role === "drafts" ? folder.totalEmails : folder.unreadEmails;
              const label = folderLabel(folder);
              return (
                <li key={folder.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(folder.id);
                    }}
                    aria-current={current ? "page" : undefined}
                    aria-label={
                      count > 0 ? `${label}, ${String(count)} ${folder.role === "drafts" ? "drafts" : "unread"}` : label
                    }
                    style={{ paddingLeft: `${String(0.625 + depth * 0.875)}rem` }}
                    className={`group flex h-9 w-full items-center gap-3 rounded-lg pr-2.5 text-left text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
                      current
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
                    }`}
                  >
                    <Icon
                      className={`size-4 shrink-0 ${current ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {count > 0 && (
                      <span
                        aria-hidden
                        className={`font-mono text-[12px] tabular-nums ${current || folder.role === "inbox" ? "text-primary" : "text-muted-foreground"}`}
                      >
                        {count > 999 ? "999+" : count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      <div className="flex shrink-0 flex-col gap-3 border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2.5 px-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground" title={username}>
            {username}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}

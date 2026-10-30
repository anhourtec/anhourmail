// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  Check,
  EllipsisVertical,
  FilePen,
  Flag,
  Folder as FolderIcon,
  Inbox,
  ExternalLink,
  House,
  Keyboard,
  LifeBuoy,
  LogOut,
  type LucideIcon,
  Mailbox as MailboxIcon,
  PenLine,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

import { FolderTreeSkeleton } from "@anhourmail/ui/skeletons";

import { PersonPhoto } from "@/components/person-photo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tooltip } from "@/components/tooltip";

import { useOwnPhoto } from "./avatars";
import { folderLabel, folderTree } from "./format";
import type { Folder, SharedMailbox, View } from "./mail-client";
import { Menu } from "./menu";

const ROLE_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  drafts: FilePen,
  sent: Send,
  archive: Archive,
  junk: ShieldAlert,
  trash: Trash2,
};

/**
 * The session's mailboxes: the active one (possibly a mailbox shared with the person, `activeShared`), its own other
 * sign-ins, and every mailbox shared with its person ("Shared with you", ADR-0026 §6).
 */
export type Mailboxes = { active: string; activeShared: boolean; others: string[]; shared: SharedMailbox[] };

const localName = (address: string) => {
  const local = address.split("@")[0] ?? address;
  return local.charAt(0).toUpperCase() + local.slice(1);
};

/**
 * A square mailbox tile: the photo shown for that mailbox (its person's, or its own; ADR-0022) or its initial, with
 * a check badge on the active one.
 */
function MailboxTile({ address, active, size = "md" }: { address: string; active: boolean; size?: "sm" | "md" }) {
  const photo = useOwnPhoto(address)?.url ?? null;
  return (
    <span
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center rounded-md bg-primary font-medium text-primary-foreground ${
        size === "sm" ? "size-7 text-[12px]" : "size-8 text-[13px]"
      }`}
    >
      <PersonPhoto
        src={photo}
        label={localName(address).charAt(0)}
        className="flex size-full items-center justify-center rounded-md"
      />
      {active && (
        <span className="-right-1 -bottom-1 absolute flex size-3.5 items-center justify-center rounded-full bg-[rgb(var(--am-status-success-bg))] text-primary-foreground ring-2 ring-sidebar">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

function NavItem({
  icon: Icon,
  label,
  count,
  current,
  collapsed,
  onClick,
  emphasis = false,
  mono = false,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  current: boolean;
  collapsed: boolean;
  onClick: () => void;
  emphasis?: boolean;
  /** The label is an address (shown in mono). */
  mono?: boolean;
}) {
  return (
    <Tooltip label={label} side="right" disabled={!collapsed}>
      <button
        type="button"
        onClick={onClick}
        aria-current={current ? "page" : undefined}
        aria-label={count > 0 ? `${label}, ${String(count)}` : label}
        className={`group flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-[13.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
          collapsed ? "justify-center px-0" : "px-2.5"
        } ${
          current
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
        }`}
      >
        <span className="relative">
          <Icon className={`size-4 shrink-0 ${current ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
          {collapsed && count > 0 && (
            <span aria-hidden className="-right-1 -top-1 absolute size-1.5 rounded-full bg-primary" />
          )}
        </span>
        {!collapsed && (
          <>
            <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[12.5px]" : ""}`}>{label}</span>
            {count > 0 && (
              <span
                aria-hidden
                className={`font-mono text-[11.5px] tabular-nums ${emphasis || current ? "text-primary" : "text-muted-foreground"}`}
              >
                {count > 999 ? "999+" : count}
              </span>
            )}
          </>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * The webmail sidebar (05-webmail.md "UI"): mailbox switcher, the signed-in address, New email, Inbox and Priority,
 * then the other folders (system first, then custom, nested), and help, shortcuts, theme and sign-out at the foot.
 * Collapses to an icon rail on wide screens; it is a drawer on small ones.
 */
export function Sidebar({
  folders,
  view,
  contactsCurrent,
  onContacts,
  priorityCount,
  mailboxes,
  collapsed,
  helpHref,
  onSelect,
  onCompose,
  onShortcuts,
  onSettings,
  onSignOut,
  onAddMailbox,
  onSwitchMailbox,
  onOpenShared,
  onOpenAnother,
  scoped = false,
  ownHref,
}: {
  folders: Folder[] | null;
  view: View | null;
  contactsCurrent: boolean;
  onContacts: () => void;
  priorityCount: number;
  mailboxes: Mailboxes;
  collapsed: boolean;
  helpHref: string;
  onSelect: (view: View) => void;
  onCompose: () => void;
  onShortcuts: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onAddMailbox: () => void;
  onSwitchMailbox: (address: string) => void;
  /** Opens a "Shared with you" mailbox in this tab (it becomes the session's active one). */
  onOpenShared: (address: string) => void;
  /** "Open another mailbox": asks for an address and opens it in a new tab. */
  onOpenAnother: () => void;
  /**
   * A tab scoped to one mailbox shared with the person (Open another mailbox): only that mailbox, no switching, and
   * `ownHref` leads to the person's own webmail.
   */
  scoped?: boolean;
  ownHref?: string;
}) {
  const shared = mailboxes.activeShared || scoped;
  // The tiles: the session's own mailboxes, plus the shared one while it is the active one (never in a scoped tab).
  const all = scoped ? [mailboxes.active] : [mailboxes.active, ...mailboxes.others];
  // "Shared with you": the mailboxes the person may open (read and manage), not the one shown now.
  const openable = scoped ? [] : mailboxes.shared.filter((m) => m.fullAccess);
  const tree = folders ? folderTree(folders) : [];
  const inbox = tree.find((n) => n.folder.role === "inbox")?.folder;
  const rest = tree.filter((n) => n.folder.role !== "inbox");
  const isCurrent = (f: Folder) => view?.kind === "folder" && view.id === f.id;
  const accountMenu = scoped
    ? [
        {
          label: "Go to your mailbox",
          icon: House,
          onSelect: () => {
            if (ownHref) window.location.assign(ownHref);
          },
        },
        { label: "Open another mailbox", icon: ExternalLink, onSelect: onOpenAnother },
      ]
    : [
        { heading: "Mailboxes" },
        ...all
          .filter((address) => !(mailboxes.activeShared && address === mailboxes.active))
          .map((address) => ({
            label: address,
            checked: address === mailboxes.active,
            onSelect: () => {
              if (address !== mailboxes.active) onSwitchMailbox(address);
            },
          })),
        ...(openable.length > 0
          ? [
              { heading: "Shared with you" },
              ...openable.map((m) => ({
                label: m.address,
                checked: mailboxes.activeShared && m.address === mailboxes.active.toLowerCase(),
                onSelect: () => {
                  if (m.address !== mailboxes.active.toLowerCase()) onOpenShared(m.address);
                },
              })),
            ]
          : []),
        { separator: true as const },
        { label: "Add another mailbox", icon: UserPlus, onSelect: onAddMailbox },
        { label: "Open another mailbox", icon: ExternalLink, onSelect: onOpenAnother },
        { label: "Sign out", icon: LogOut, onSelect: onSignOut },
      ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className={`flex shrink-0 flex-col gap-3 pt-3 pb-2 ${collapsed ? "items-center px-2" : "px-3"}`}>
        <div className="flex items-center gap-1.5">
          {collapsed ? (
            <Menu
              label="Mailboxes and account"
              icon={EllipsisVertical}
              align="start"
              items={accountMenu}
              trigger={<MailboxTile address={mailboxes.active} active />}
            />
          ) : (
            <>
              <div role="radiogroup" aria-label="Mailboxes" className="flex flex-1 flex-wrap items-center gap-1.5">
                {all.map((address) => (
                  <Tooltip key={address} label={address}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={address === mailboxes.active}
                      aria-label={address}
                      onClick={() => {
                        if (address !== mailboxes.active) onSwitchMailbox(address);
                      }}
                      className="rounded-md focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                    >
                      <MailboxTile address={address} active={address === mailboxes.active} />
                    </button>
                  </Tooltip>
                ))}
              </div>
              <Menu label="Mailboxes and account" icon={EllipsisVertical} items={accountMenu} />
            </>
          )}
        </div>
        {!collapsed && (
          <div className="flex min-w-0 flex-col gap-0.5 border-sidebar-border border-t pt-3">
            {shared && <span className="am-micro">Shared with you</span>}
            <span className="truncate font-medium text-[14px]">{localName(mailboxes.active)}</span>
            <Tooltip label={mailboxes.active}>
              <span className="truncate font-mono text-[12px] text-muted-foreground">{mailboxes.active}</span>
            </Tooltip>
          </div>
        )}
        {/* A mailbox shared with the person: sending is from their own mailbox (choose it in From there). */}
        {!shared && (
          <Tooltip label="New email" shortcut="c" side={collapsed ? "right" : "bottom"}>
            <button
              type="button"
              onClick={onCompose}
              aria-label="New email"
              className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border bg-background font-medium text-[13.5px] shadow-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${
                collapsed ? "w-9" : "w-full"
              }`}
            >
              <PenLine className="size-4" aria-hidden />
              {!collapsed && "New email"}
            </button>
          </Tooltip>
        )}
      </div>

      <nav aria-label="Folders" className={`min-h-0 flex-1 overflow-y-auto pb-3 ${collapsed ? "px-2" : "px-2"}`}>
        {folders === null ? (
          <FolderTreeSkeleton folders={8} />
        ) : (
          <div className="flex flex-col gap-0.5 pt-1">
            {inbox && (
              <NavItem
                icon={Inbox}
                label="Inbox"
                count={inbox.unreadEmails}
                current={isCurrent(inbox)}
                collapsed={collapsed}
                emphasis
                onClick={() => {
                  onSelect({ kind: "folder", id: inbox.id });
                }}
              />
            )}
            <NavItem
              icon={Flag}
              label="Priority"
              count={priorityCount}
              current={view?.kind === "priority"}
              collapsed={collapsed}
              onClick={() => {
                onSelect({ kind: "priority" });
              }}
            />
            {!collapsed && <p className="am-micro px-2.5 pt-4 pb-1">Folders</p>}
            {collapsed && <div className="mx-2 my-2 h-px bg-sidebar-border" />}
            {rest.map(({ folder, depth }) => (
              <div key={folder.id} style={collapsed ? undefined : { paddingLeft: `${String(depth * 0.875)}rem` }}>
                <NavItem
                  icon={(folder.role ? ROLE_ICON[folder.role] : undefined) ?? FolderIcon}
                  label={folderLabel(folder)}
                  count={
                    folder.role === "drafts" ? folder.totalEmails : folder.role === "sent" ? 0 : folder.unreadEmails
                  }
                  current={isCurrent(folder)}
                  collapsed={collapsed}
                  onClick={() => {
                    onSelect({ kind: "folder", id: folder.id });
                  }}
                />
              </div>
            ))}
            {openable.length > 0 && (
              <>
                {!collapsed && <p className="am-micro px-2.5 pt-4 pb-1">Shared with you</p>}
                {collapsed && <div className="mx-2 my-2 h-px bg-sidebar-border" />}
                {openable.map((m) => (
                  <NavItem
                    key={m.address}
                    icon={MailboxIcon}
                    label={m.address}
                    count={0}
                    current={mailboxes.activeShared && m.address === mailboxes.active.toLowerCase()}
                    collapsed={collapsed}
                    mono
                    onClick={() => {
                      if (m.address !== mailboxes.active.toLowerCase()) onOpenShared(m.address);
                    }}
                  />
                ))}
              </>
            )}
            {!shared && (
              <>
                {collapsed ? <div className="mx-2 my-2 h-px bg-sidebar-border" /> : <div className="pt-3" />}
                <NavItem
                  icon={Users}
                  label="Contacts"
                  count={0}
                  current={contactsCurrent}
                  collapsed={collapsed}
                  onClick={onContacts}
                />
              </>
            )}
          </div>
        )}
      </nav>

      <div
        className={`flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t p-2 ${collapsed ? "items-center" : ""}`}
      >
        <Tooltip label="Help & feedback" side="right" disabled={!collapsed}>
          <a
            href={helpHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Help & feedback"
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg text-[13.5px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground ${collapsed ? "justify-center" : "px-2.5"}`}
          >
            <LifeBuoy className="size-4 text-muted-foreground" aria-hidden />
            {!collapsed && "Help & feedback"}
          </a>
        </Tooltip>
        <Tooltip label="Settings" shortcut="," side="right" disabled={!collapsed}>
          <button
            type="button"
            onClick={onSettings}
            aria-label="Settings"
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-[13.5px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground ${collapsed ? "justify-center" : "px-2.5"}`}
          >
            <Settings className="size-4 text-muted-foreground" aria-hidden />
            {!collapsed && "Settings"}
          </button>
        </Tooltip>
        <Tooltip label="Keyboard shortcuts" shortcut="?" side="right" disabled={!collapsed}>
          <button
            type="button"
            onClick={onShortcuts}
            aria-label="Keyboard shortcuts"
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-[13.5px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground ${collapsed ? "justify-center" : "px-2.5"}`}
          >
            <Keyboard className="size-4 text-muted-foreground" aria-hidden />
            {!collapsed && "Keyboard shortcuts"}
          </button>
        </Tooltip>
        {!collapsed && (
          <div className="flex items-center justify-between gap-2 px-1 pt-2">
            <ThemeToggle />
            {!scoped && (
              <Tooltip label="Sign out">
                <button
                  type="button"
                  onClick={onSignOut}
                  aria-label="Sign out"
                  className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                >
                  <LogOut className="size-4" aria-hidden />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

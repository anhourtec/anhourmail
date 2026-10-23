// SPDX-License-Identifier: AGPL-3.0-only
import {
  BookOpenText,
  CalendarClock,
  CircleUser,
  Forward,
  Globe,
  type LucideIcon,
  Palette,
  PenLine,
  ShieldAlert,
} from "lucide-react";

/**
 * The settings window's groups (docs/internal/05-webmail.md "Settings"): a few clear groups rather than many tabs,
 * each with the words people search for. Search matches the label or any keyword.
 */
export type SectionId = "appearance" | "reading" | "writing" | "replies" | "forwarding" | "junk" | "account" | "region";

export type Section = { id: SectionId; label: string; icon: LucideIcon; summary: string; keywords: string[] };

export const SECTIONS: readonly Section[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    summary: "Theme, density, reading pane and the message list",
    keywords: [
      "theme",
      "dark",
      "light",
      "density",
      "compact",
      "roomy",
      "spacing",
      "text size",
      "reading pane",
      "layout",
      "preview",
      "lines",
      "conversation",
      "threads",
      "grouping",
      "avatars",
      "initials",
      "attachments",
      "date headers",
      "animation",
      "motion",
      "sender first",
      "subject first",
    ],
  },
  {
    id: "reading",
    label: "Reading",
    icon: BookOpenText,
    summary: "Marking as read, new-mail sound, images and what opens next",
    keywords: [
      "sound",
      "chime",
      "notification",
      "desktop notifications",
      "new mail",
      "mark as read",
      "unread",
      "images",
      "remote images",
      "pictures",
      "privacy",
      "after delete",
      "after archive",
      "next message",
      "read receipts",
      "moving",
    ],
  },
  {
    id: "writing",
    label: "Writing",
    icon: PenLine,
    summary: "Signatures, replies and undo send",
    keywords: ["signature", "reply", "reply all", "undo send", "delay", "cc", "bcc", "format", "plain text", "compose"],
  },
  {
    id: "replies",
    label: "Automatic replies",
    icon: CalendarClock,
    summary: "Answer mail while you're away",
    keywords: ["vacation", "out of office", "away", "auto reply", "auto-reply", "holiday", "autoresponder"],
  },
  {
    id: "forwarding",
    label: "Forwarding",
    icon: Forward,
    summary: "Send a copy of new mail to another address",
    keywords: ["forward", "redirect", "copy", "another address", "keep a copy"],
  },
  {
    id: "junk",
    label: "Junk and blocked senders",
    icon: ShieldAlert,
    summary: "Block senders and trust the ones you know",
    keywords: ["junk", "spam", "block", "blocked", "safe senders", "trusted", "contacts only", "domain", "filter"],
  },
  {
    id: "account",
    label: "Account",
    icon: CircleUser,
    summary: "Your name, addresses, storage, password and signing out",
    keywords: [
      "name",
      "display name",
      "sender name",
      "address",
      "aliases",
      "storage",
      "quota",
      "space",
      "password",
      "change password",
      "sign out",
      "log out",
      "empty trash",
    ],
  },
  {
    id: "region",
    label: "Region and shortcuts",
    icon: Globe,
    summary: "Dates, times, time zone, keyboard and start folder",
    keywords: [
      "language",
      "region",
      "date format",
      "time format",
      "24-hour",
      "12-hour",
      "time zone",
      "keyboard",
      "shortcuts",
      "start in",
      "start folder",
      "inbox",
    ],
  },
];

/** Sections whose label or keywords contain the query (all when it is blank). */
export function matchSections(query: string): Section[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...SECTIONS];
  return SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q)));
}

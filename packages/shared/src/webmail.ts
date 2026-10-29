// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail preferences (docs/internal/05-webmail.md "Settings"): how the webmail looks and behaves for one mailbox.
 * Stored per mailbox in the control plane (`webmail_preference`), never mail content and no addresses (the senders
 * whose images load are kept as keyed hashes, `imageSenders`). Mail-flow settings (automatic replies, forwarding,
 * junk rules, signatures) live in the mail server instead.
 *
 * No schema library here (this package has no dependencies): `normalizePreferences` reads anything stored and
 * falls back to the default per field, and `parsePreferencePatch` accepts only known keys with allowed values.
 */

export const DENSITIES = ["compact", "comfortable", "roomy"] as const;
export const READING_PANES = ["right", "bottom", "off"] as const;
export const PREVIEW_LINES = [0, 1, 2] as const;
export const GROUPINGS = ["conversations", "messages"] as const;
export const THEMES = ["system", "light", "dark"] as const;
export const MOTIONS = ["system", "reduced"] as const;
export const MARK_READ = ["open", "delay", "never"] as const;
export const MARK_READ_DELAYS = [2, 5, 10, 30] as const;
export const AFTER_MOVE = ["next", "previous", "list"] as const;
export const DEFAULT_REPLY = ["reply", "replyAll"] as const;
/** Seconds a sent message is held so it can be undone (FUTURERELEASE HOLDFOR; Stalwart allows far longer). */
export const UNDO_SEND_SECONDS = [5, 10, 20, 30] as const;
/** Date formats: English for now, in the conventions of these regions (Intl locale tags). */
export const REGIONS = [
  { id: "en-CA", label: "Canada" },
  { id: "en-US", label: "United States" },
  { id: "en-GB", label: "United Kingdom" },
  { id: "en-AU", label: "Australia" },
  { id: "en-NZ", label: "New Zealand" },
  { id: "en-IE", label: "Ireland" },
  { id: "en-IN", label: "India" },
] as const;
export const HOUR_CYCLES = ["auto", "h12", "h23"] as const;
/** When remote images load (through the image proxy): only when asked, also for senders in contacts, or always. */
export const REMOTE_IMAGE_MODES = ["ask", "contacts", "always"] as const;

/**
 * Remote images in the webmail (published in the docs, enforced by the image proxy): the largest image in MB
 * (1 MB = 1024 × 1024 bytes), how many images of one message can be loaded, how many redirects are followed, how
 * long one image may take, how long a message's image links stay valid, and how many senders can be remembered.
 */
export const REMOTE_IMAGES = {
  maxMb: 5,
  perMessage: 100,
  maxRedirects: 3,
  timeoutSeconds: 10,
  linkMinutes: 60,
  maxSenders: 500,
} as const;

/** A remembered sender: a keyed hash of the address (base64url, 22 characters), never the address itself. */
const SENDER_KEY = /^[A-Za-z0-9_-]{22}$/;
export const isSenderKey = (v: unknown): v is string => typeof v === "string" && SENDER_KEY.test(v);

export type WebmailPreferences = {
  theme: (typeof THEMES)[number];
  density: (typeof DENSITIES)[number];
  readingPane: (typeof READING_PANES)[number];
  previewLines: (typeof PREVIEW_LINES)[number];
  grouping: (typeof GROUPINGS)[number];
  /** Sender on the first line of a list row (else the subject). */
  senderFirst: boolean;
  avatars: boolean;
  attachmentChips: boolean;
  dateHeaders: boolean;
  motion: (typeof MOTIONS)[number];
  markRead: (typeof MARK_READ)[number];
  markReadDelay: (typeof MARK_READ_DELAYS)[number];
  afterMove: (typeof AFTER_MOVE)[number];
  markReadOnMove: boolean;
  defaultReply: (typeof DEFAULT_REPLY)[number];
  undoSeconds: (typeof UNDO_SEND_SECONDS)[number];
  showCcBcc: boolean;
  region: (typeof REGIONS)[number]["id"];
  hourCycle: (typeof HOUR_CYCLES)[number];
  /** "auto" (the device's) or an IANA time zone name. */
  timeZone: string;
  shortcuts: boolean;
  /** "inbox", "priority" or "folder:<JMAP mailbox id>". */
  startIn: string;
  emptyTrashOnSignOut: boolean;
  /** A short chime when new mail reaches the Inbox while the webmail is open. */
  newMailSound: boolean;
  /** A desktop notification (sender and "New message", never the content) for new Inbox mail. */
  desktopNotifications: boolean;
  /** When remote images load through the image proxy without asking. */
  remoteImages: (typeof REMOTE_IMAGE_MODES)[number];
  /** Senders whose images always load: keyed hashes from the server (`MessageView.senderKey`), never addresses. */
  imageSenders: string[];
};

export const DEFAULT_PREFERENCES: Readonly<WebmailPreferences> = {
  theme: "system",
  density: "comfortable",
  readingPane: "right",
  previewLines: 2,
  grouping: "conversations",
  senderFirst: true,
  avatars: true,
  attachmentChips: false,
  dateHeaders: false,
  motion: "system",
  markRead: "open",
  markReadDelay: 5,
  afterMove: "next",
  markReadOnMove: false,
  defaultReply: "reply",
  undoSeconds: 10,
  showCcBcc: false,
  region: "en-CA",
  hourCycle: "auto",
  timeZone: "auto",
  shortcuts: true,
  startIn: "inbox",
  emptyTrashOnSignOut: false,
  newMailSound: true,
  desktopNotifications: false,
  remoteImages: "ask",
  imageSenders: [],
};

const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
const START_IN = /^(?:inbox|priority|folder:[A-Za-z0-9_-]{1,255})$/;

type Check = (v: unknown) => boolean;
const oneOf =
  (list: readonly unknown[]): Check =>
  (v) =>
    list.includes(v);
const bool: Check = (v) => typeof v === "boolean";

const CHECKS: { [K in keyof WebmailPreferences]: Check } = {
  theme: oneOf(THEMES),
  density: oneOf(DENSITIES),
  readingPane: oneOf(READING_PANES),
  previewLines: oneOf(PREVIEW_LINES),
  grouping: oneOf(GROUPINGS),
  senderFirst: bool,
  avatars: bool,
  attachmentChips: bool,
  dateHeaders: bool,
  motion: oneOf(MOTIONS),
  markRead: oneOf(MARK_READ),
  markReadDelay: oneOf(MARK_READ_DELAYS),
  afterMove: oneOf(AFTER_MOVE),
  markReadOnMove: bool,
  defaultReply: oneOf(DEFAULT_REPLY),
  undoSeconds: oneOf(UNDO_SEND_SECONDS),
  showCcBcc: bool,
  region: oneOf(REGIONS.map((r) => r.id)),
  hourCycle: oneOf(HOUR_CYCLES),
  timeZone: (v) => v === "auto" || (typeof v === "string" && TIME_ZONE.test(v)),
  shortcuts: bool,
  startIn: (v) => typeof v === "string" && START_IN.test(v),
  emptyTrashOnSignOut: bool,
  newMailSound: bool,
  desktopNotifications: bool,
  remoteImages: oneOf(REMOTE_IMAGE_MODES),
  imageSenders: (v) =>
    Array.isArray(v) && v.length <= REMOTE_IMAGES.maxSenders && v.every(isSenderKey) && new Set(v).size === v.length,
};

const KEYS = Object.keys(CHECKS) as (keyof WebmailPreferences)[];

/** Stored preferences (any shape) → a complete, valid set: unknown keys dropped, bad values back to the default. */
export function normalizePreferences(stored: unknown): WebmailPreferences {
  const src = stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  for (const key of KEYS) {
    if (Object.hasOwn(src, key) && CHECKS[key](src[key])) out[key] = src[key];
  }
  // A fresh array: the default's must never be shared (and changed) between results.
  out.imageSenders = [...(out.imageSenders as string[])];
  return out as WebmailPreferences;
}

/**
 * A change from the browser: an object of known keys with allowed values (at least one). Null when anything is
 * unknown or invalid — a change is applied whole or not at all.
 */
export function parsePreferencePatch(input: unknown): Partial<WebmailPreferences> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > KEYS.length) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!Object.hasOwn(CHECKS, key) || !CHECKS[key as keyof WebmailPreferences](value)) return null;
    out[key] = value;
  }
  return out;
}

/**
 * The name of the one Sieve script we manage in every customer mailbox (automatic replies, forwarding, junk rules).
 * Shared by the webmail BFF (writes it) and provisioning (re-activates it if a user switched it off).
 */
export const MANAGED_SIEVE_SCRIPT = "anhourmail";

/**
 * The comment line in the managed script that carries its settings (base64url JSON). The webmail writes it; the
 * reconciler reads it to check the script still matches what the control plane allows (e.g. forwarding only to a
 * confirmed target).
 */
export const MANAGED_SIEVE_SETTINGS_PREFIX = "# am-settings: ";

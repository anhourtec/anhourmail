// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail and contacts import facts (ADR-0030): published limits the console, the docs and the importer share (rule 32),
 * the folder mapping vocabulary, and the contacts CSV column aliases. Capacity settings (throttles, global
 * concurrency, slice length) are deployment config, not facts: they live in the importer's environment.
 */
import { ACCOUNT_POLICY } from "./plans";

export const IMPORT = {
  /** Days the destination credential lives for a one-off import (resume renews it). */
  credentialDays: 7,
  /** Cut-over sync: days from the start it keeps copying new mail at most (also the credential's life then). */
  syncWindowDays: 14,
  /** Minutes between cut-over sync passes. */
  syncEveryMinutes: 30,
  /** Imports running at once per account (more wait in the queue). */
  perAccountConcurrency: 2,
  /** Largest message copied (bytes): the receive limit, under the mail server's 50 MiB request limit. */
  maxMessageBytes: ACCOUNT_POLICY.receiveMessageMb * 1000 * 1000,
  /** Folder depth and count, counted with the mailbox's existing folders (the mail server's own limits). */
  maxFolderDepth: 10,
  maxFolders: 250,
  /** IMAP ports a source may use: 993 (TLS) or 143 (STARTTLS required). Nothing else is ever connected to. */
  sourcePorts: [993, 143] as const,
  defaultSourcePort: 993,
  /** Keywords kept per message, and the longest kept (longer ones are dropped). */
  maxKeywords: 20,
  maxKeywordLength: 64,
  /** Contacts file upload (vCard or CSV), per file; the mailbox's own card limit still applies. */
  contactsMaxBytes: 5 * 1024 * 1024,
  contactsMaxCards: 5000,
  /** Admins' batch CSV (one row per mailbox). */
  batchMaxBytes: 256 * 1024,
} as const;

export type ImportSourcePort = (typeof IMPORT.sourcePorts)[number];

export const isImportSourcePort = (port: unknown): port is ImportSourcePort =>
  typeof port === "number" && (IMPORT.sourcePorts as readonly number[]).includes(port);

/** An import's life (`mail_import.status`). The last three are terminal: the credentials are wiped with them. */
export const IMPORT_STATUSES = [
  "queued",
  "running",
  "paused",
  "blocked",
  "syncing",
  "completed",
  "cancelled",
  "failed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const IMPORT_TERMINAL_STATUSES = ["completed", "cancelled", "failed"] as const satisfies readonly ImportStatus[];
export const isTerminalImportStatus = (s: ImportStatus): boolean =>
  (IMPORT_TERMINAL_STATUSES as readonly string[]).includes(s);

export const IMPORT_PHASES = ["verifying", "copying"] as const;
export type ImportPhase = (typeof IMPORT_PHASES)[number];

/** Why an import waits for the person (each has a fix in the console). */
export const IMPORT_BLOCKED_REASONS = [
  "quota_full",
  "source_auth",
  "source_unreachable",
  "source_certificate",
  "source_tls_required",
  "destination_credential",
  "mailbox_unavailable",
] as const;
export type ImportBlockedReason = (typeof IMPORT_BLOCKED_REASONS)[number];

/** How the source is signed in to: an app password today; OAuth later (ADR-0030 §11). */
export const IMPORT_SOURCE_KINDS = ["imap_password"] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KINDS)[number];

// ---- folders --------------------------------------------------------------------------------------------------

/** Destination roles a source folder can map to (`mail_import_folder.role`); null is a custom folder. */
export const IMPORT_FOLDER_ROLES = ["inbox", "sent", "drafts", "junk", "trash", "archive", "all"] as const;
export type ImportFolderRole = (typeof IMPORT_FOLDER_ROLES)[number];

/** RFC 6154 special-use attributes we map (`\All` is copied last, into Archive, de-duplicated against everything). */
export const IMPORT_SPECIAL_USE: Readonly<Record<string, ImportFolderRole>> = {
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Junk": "junk",
  "\\Trash": "trash",
  "\\Archive": "archive",
  "\\All": "all",
};

/** Virtual folders that only show mail living elsewhere: never copied. */
export const IMPORT_SKIPPED_SPECIAL_USE: readonly string[] = ["\\Flagged", "\\Important"];

/** Where each role lands in the destination (its special-use attribute there; `all` goes into Archive). */
export const IMPORT_DESTINATION_SPECIAL_USE: Readonly<Record<ImportFolderRole, string | null>> = {
  inbox: null,
  sent: "\\Sent",
  drafts: "\\Drafts",
  junk: "\\Junk",
  trash: "\\Trash",
  archive: "\\Archive",
  all: "\\Archive",
};

/** The destination's hierarchy delimiter; a `/` inside a source folder's own name becomes this. */
export const IMPORT_DELIMITER = "/";
export const IMPORT_NAME_SLASH_REPLACEMENT = "-";
/** Where custom folders go when the person asks for a subfolder, and where folders past the count limit go. */
export const IMPORT_SUBFOLDER = "Imported";
/** Joins a folder flattened past the depth limit into its deepest allowed parent ("Parent - Child"). */
export const IMPORT_FLATTEN_SEPARATOR = " - ";

/** Flags copied as they are (`\Recent` is never copied; `\Deleted` messages are skipped). */
export const IMPORT_SYSTEM_FLAGS: readonly string[] = ["\\Seen", "\\Answered", "\\Flagged", "\\Draft"];

/**
 * Spam-training keywords, dropped: folder placement carries that meaning. On the pinned mail server every APPEND
 * becomes a spam-training sample by folder (Junk, or `$Junk`: spam; anything else: ham; research/stalwart.md
 * "Mail import over IMAP"), so a source's `$Junk` on an Inbox message would teach it the wrong thing.
 */
export const IMPORT_DROPPED_KEYWORDS: readonly string[] = ["$Junk", "$NotJunk", "Junk", "NonJunk"];

/** The header the importer prepends to every message it copies; the webmail treats such mail as not verified by us. */
export const IMPORT_MARKER_HEADER = "X-AnhourMail-Imported";

// ---- sources --------------------------------------------------------------------------------------------------

/**
 * Source choices in the console's "New import" form. Provider presets (with their own setup pages) are added with
 * the public import guides (ADR-0030 §17–18); until then every source is "Other IMAP server".
 */
export type ImportSourcePreset = {
  id: string;
  name: string;
  /** Null: the person types the host. */
  host: string | null;
  port: ImportSourcePort;
  /** The public docs page explaining how to make an app password there. */
  docsSlug: string;
  /** OAuth sign-in (ADR-0030 §11): not built, so always null for now. */
  oauth: null;
};

export const IMPORT_SOURCE_PRESETS: readonly ImportSourcePreset[] = [
  { id: "other", name: "Other IMAP server", host: null, port: 993, docsSlug: "import/imap", oauth: null },
];

// ---- contacts CSV ---------------------------------------------------------------------------------------------

/** Card fields a CSV column can fill. `emails`, `phones` and `labels` take any number of columns. */
export const IMPORT_CSV_FIELDS = [
  "fullName",
  "given",
  "surname",
  "emails",
  "phones",
  "organization",
  "notes",
  "birthday",
  "labels",
] as const;
export type ImportCsvField = (typeof IMPORT_CSV_FIELDS)[number];
export const IMPORT_CSV_MULTI_FIELDS: readonly ImportCsvField[] = ["emails", "phones", "labels"];

/** A header as compared for auto-detection: lower-case letters and digits only ("E-mail 2 Address" → "email2address"). */
export const normalizeCsvHeader = (header: string): string =>
  header
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Column aliases by normalised header, tried in order (first match wins). Covers the column names contacts apps
 * commonly export: "First Name", "Given Name", "Last Name", "Family Name", "Display Name", "E-mail Address",
 * "E-mail 2 Address", "Email 1 - Value", "Mobile Phone", "Phone 1 - Value", "Company", "Organization Name", "Notes",
 * "Birthday", "Categories", "Group Membership", "Labels".
 */
export const IMPORT_CSV_COLUMNS: readonly { field: ImportCsvField; pattern: RegExp }[] = [
  { field: "given", pattern: /^(first|given)(name)?$/ },
  { field: "surname", pattern: /^(last|family|sur)(name)?$/ },
  { field: "fullName", pattern: /^(full|display)?name$|^(contact|person)name$/ },
  {
    field: "emails",
    pattern: /^(primary|secondary|work|home|other|personal|business)?e?mail\d*(address|addr)?\d*(value)?$/,
  },
  {
    field: "phones",
    pattern:
      /^(primary|work|home|business|mobile|cell|other|personal|main|car|pager)?(phone|mobile|cell|tel|telephone)\d*(number|no)?\d*(value)?$|^mobile$/,
  },
  { field: "organization", pattern: /^(company|organi[sz]ation|org|employer)\d*(name)?$/ },
  { field: "notes", pattern: /^(notes?|comments?)$/ },
  { field: "birthday", pattern: /^(birthday|birthdate|dateofbirth|dob)$/ },
  { field: "labels", pattern: /^(categories|category|groups?|groupmembership|labels?|tags?)$/ },
];

/**
 * The detected field per column (null: not imported, e.g. "Middle Name" or "E-mail 1 - Type"). A single-valued
 * field goes to the first column that matches it; later ones are left out.
 */
export function detectCsvColumns(header: readonly string[]): (ImportCsvField | null)[] {
  const taken = new Set<ImportCsvField>();
  return header.map((h) => {
    const n = normalizeCsvHeader(h);
    if (n === "") return null;
    const hit = IMPORT_CSV_COLUMNS.find((c) => c.pattern.test(n))?.field ?? null;
    if (hit === null) return null;
    if (!IMPORT_CSV_MULTI_FIELDS.includes(hit)) {
      if (taken.has(hit)) return null;
      taken.add(hit);
    }
    return hit;
  });
}

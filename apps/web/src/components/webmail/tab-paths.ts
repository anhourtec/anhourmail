// SPDX-License-Identifier: AGPL-3.0-only

/** Where the webmail's pages live on this origin ("" on the webmail host, "/webmail" on a dev bare host). */
export const pagesBase = (): string =>
  typeof window !== "undefined" && window.location.pathname.startsWith("/webmail") ? "/webmail" : "";

/**
 * The address-scoped page of a mailbox shared with the person (ADR-0026 §6, Open another mailbox):
 * `<base>/mailbox/<address>`, or `<base>/mailbox/<address>/<folder>` for one folder (a role such as `sent`, or a folder
 * id). The address keeps its `@`, so the link reads as the mailbox it opens.
 */
export function mailboxTabHref(base: string, address: string, folder?: string): string {
  const a = encodeURIComponent(address.trim().toLowerCase()).replace(/%40/g, "@");
  return `${base}/mailbox/${a}${folder ? `/${encodeURIComponent(folder)}` : ""}`;
}

/** Folder roles a mailbox-scoped page can name in its URL (any other segment is a folder id). */
export const FOLDER_ROLES = ["inbox", "drafts", "sent", "archive", "junk", "trash"] as const;

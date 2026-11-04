// SPDX-License-Identifier: AGPL-3.0-only
/** The importer's IMAP adapters (ADR-0030 §3): the only code that speaks IMAP (imapflow), besides an int-test helper. */
export {
  baseOptions,
  CLIENT_INFO,
  connectFailure,
  type ImapClientOptions,
  type ImapTarget,
  openImapClient,
  sessionFailure,
  sourceTarget,
} from "./connect";
export { destinationPath, foreignNamespaces, imapMailDestination, SHARED_FOLDERS_PREFIX } from "./destination";
export { imapMailSource, toSourceFolder } from "./source";

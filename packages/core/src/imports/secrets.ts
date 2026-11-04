// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sealing an import's secrets (ADR-0030 §2; rules 16 and 23): AES-256-GCM through the key ring
 * (`@anhourmail/server/keyring`), each kind under its own purpose and bound to its import by AAD, so a sealed value
 * copied to another row or column doesn't open. Services seal before they write and open only in the importer, for
 * one slice; nothing here logs.
 */

/** The part of the key ring this needs (passed in by the app). */
export type ImportSealer = {
  encrypt(purpose: string, plaintext: string, aad: string): string;
  decrypt(purpose: string, sealed: string, aad: string): string;
};

export const IMPORT_SECRET_PURPOSES = {
  /** The old provider's app password. */
  source: "mail-import-source",
  /** The destination's IMAP-only credential (minted by the web app's operations key). */
  destination: "mail-import-destination",
  /** Source folder paths while the import runs. */
  folder: "mail-import-folder",
} as const;

export const importSourceAad = (importId: string): string => `mail_import:${importId}:source`;
export const importDestinationAad = (importId: string): string => `mail_import:${importId}:destination`;
/** Bound to the import and to the folder row, so a sealed path can't be moved to another folder of the same import. */
export const importFolderAad = (importId: string, folderId: string): string =>
  `mail_import_folder:${importId}:${folderId}`;

export const sealSourceSecret = (sealer: ImportSealer, importId: string, secret: string): string =>
  sealer.encrypt(IMPORT_SECRET_PURPOSES.source, secret, importSourceAad(importId));
export const openSourceSecret = (sealer: ImportSealer, importId: string, sealed: string): string =>
  sealer.decrypt(IMPORT_SECRET_PURPOSES.source, sealed, importSourceAad(importId));

export const sealDestinationSecret = (sealer: ImportSealer, importId: string, secret: string): string =>
  sealer.encrypt(IMPORT_SECRET_PURPOSES.destination, secret, importDestinationAad(importId));
export const openDestinationSecret = (sealer: ImportSealer, importId: string, sealed: string): string =>
  sealer.decrypt(IMPORT_SECRET_PURPOSES.destination, sealed, importDestinationAad(importId));

export const sealFolderPath = (sealer: ImportSealer, importId: string, folderId: string, path: string): string =>
  sealer.encrypt(IMPORT_SECRET_PURPOSES.folder, path, importFolderAad(importId, folderId));
export const openFolderPath = (sealer: ImportSealer, importId: string, folderId: string, sealed: string): string =>
  sealer.decrypt(IMPORT_SECRET_PURPOSES.folder, sealed, importFolderAad(importId, folderId));

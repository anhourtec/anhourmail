// SPDX-License-Identifier: AGPL-3.0-only
import type { ExportArchiver, ExportFile } from "@anhourmail/core/data";
import type { KeyRing } from "@anhourmail/server/keyring";
import { zipFiles } from "@anhourmail/server/zip";

/** Key-ring purpose for export archives (its own derived key; ADR-0025). */
const PURPOSE = "data-export";

/**
 * Data export archives (ADR-0025): a ZIP of the export's files, sealed with the key ring (AES-256-GCM, key id in the
 * output, AAD `data_export:<id>` so an archive can't be served as another export). Only sealed bytes reach the database.
 */
export function sealedArchiver(ring: KeyRing): ExportArchiver {
  return {
    pack: async (exportId: string, files: readonly ExportFile[], at: Date) =>
      ring.encryptBytes(PURPOSE, await zipFiles(files, at), `data_export:${exportId}`),
    open: async (exportId: string, sealed: Uint8Array) => ring.decryptBytes(PURPOSE, sealed, `data_export:${exportId}`),
  };
}

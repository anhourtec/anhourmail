// SPDX-License-Identifier: AGPL-3.0-only
import type { Folder, Grouping, ListRow, View } from "./list-query";

/**
 * The last first view of each mailbox signed in on this browser, in IndexedDB (docs/internal/05-webmail.md "First
 * load"): its folders with counts, the Priority count, and the first window of the view it opens in — list summaries
 * only (sender, recipients, subject, the preview line, flags, and attachment names and types when the list shows
 * them), never a message body or an attachment's content. The webmail paints it the moment the page has confirmed the
 * session, then replaces it with the server's answer.
 *
 * - **Encrypted** (AES-GCM, the mailbox address as additional data) under the session's view key: 32 random bytes the
 *   server keeps sealed next to the webmail session record and hands only to the webmail page of a checked session
 *   (`WebmailSessionStore.viewKey`). The app imports it as a non-extractable `CryptoKey` and keeps it in memory only;
 *   it is never written to browser storage. When the session ends the server deletes the key, so whatever is still on
 *   disk can't be read; an entry another session wrote doesn't open and is removed.
 * - Keyed by the mailbox address; read only for the mailbox the page is showing and never for a mailbox shared with
 *   the person (those tabs always load from the server).
 * - Cleared entirely on sign-out, on adding or switching a mailbox, whenever the server says the session ended, and
 *   when the sign-in page opens. A clear in any tab bumps an epoch in localStorage and is announced on a
 *   `BroadcastChannel`: every open tab of this browser then stops writing.
 * - Every access is wrapped: no IndexedDB or WebCrypto (a private window, storage blocked, plain http) just means no
 *   instant paint.
 */

export type CachedView = {
  v: 1;
  /** The mailbox address (lowercase). */
  address: string;
  /** What the list was built with: the `startIn` preference, grouping and attachment chips. */
  start: string;
  grouping: Grouping;
  attachments: boolean;
  folders: Folder[];
  priorityCount: number;
  view: View;
  list: { pinned: ListRow[]; total: number; rows: ListRow[] };
  savedAt: number;
};

/** What IndexedDB holds per address: the sealed entry. */
type Sealed = { v: 2; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

const DB = "anhourmail-webmail";
const STORE = "first-view";
/** The clear counter shared by the tabs of this browser (localStorage) and the channel announcing a clear. */
export const EPOCH_KEY = "am.webmail.view-cache.epoch";
export const CHANNEL = "anhourmail-webmail-view-cache";
/** Older entries are dropped rather than shown. */
export const MAX_AGE_MS = 14 * 86_400_000;

const readEpoch = (): string => {
  try {
    return globalThis.localStorage.getItem(EPOCH_KEY) ?? "0";
  } catch {
    return "0";
  }
};

/** This page's view of the cache: closed after a clear here or in another tab, or when the epoch moved. */
const state = { closed: false, epoch: readEpoch() };
let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      state.closed = true;
    };
    // Never keeps a process (tests, a server render) alive.
    (channel as unknown as { unref?: () => void }).unref?.();
  }
} catch {
  channel = null;
}

/** Whether this page may still write: nothing cleared here or in another tab since it loaded. */
export function writesAllowed(): boolean {
  if (!state.closed && readEpoch() !== state.epoch) state.closed = true;
  return !state.closed;
}

/** The page's view key as a non-extractable AES-GCM key; null when there is none or no WebCrypto. */
export async function importViewKey(raw: string | null | undefined): Promise<CryptoKey | null> {
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await globalThis.crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

const key = (address: string) => address.trim().toLowerCase();
const aad = (address: string) => new TextEncoder().encode(`anhourmail-first-view\0${key(address)}`);

/** Seals an entry for `entry.address` under `cryptoKey`. */
export async function sealView(entry: CachedView, cryptoKey: CryptoKey): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(entry.address) },
    cryptoKey,
    new TextEncoder().encode(JSON.stringify(entry)),
  );
  return { v: 2, iv, data };
}

/** Opens a stored value for `address`; null when it isn't ours, was sealed under another key, or was altered. */
export async function openView(stored: unknown, cryptoKey: CryptoKey, address: string): Promise<CachedView | null> {
  if (typeof stored !== "object" || stored === null) return null;
  const s = stored as Partial<Sealed>;
  if (s.v !== 2 || !(s.iv instanceof Uint8Array) || !(s.data instanceof ArrayBuffer)) return null;
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: s.iv, additionalData: aad(address) },
      cryptoKey,
      s.data,
    );
    const v = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    return isCachedView(v, address) ? v : null;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        resolve(null);
      };
      req.onblocked = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        let value: T | null = null;
        req.onsuccess = () => {
          value = req.result;
        };
        tx.oncomplete = () => {
          resolve(value);
        };
        tx.onerror = () => {
          resolve(null);
        };
        tx.onabort = () => {
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  } finally {
    db.close();
  }
}

/** Whether a decrypted value has the shape of an entry for `address` (anything else is ignored). */
export function isCachedView(v: unknown, address: string, now = Date.now()): v is CachedView {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const list = c.list as Record<string, unknown> | null | undefined;
  return (
    c.v === 1 &&
    c.address === key(address) &&
    typeof c.start === "string" &&
    (c.grouping === "conversations" || c.grouping === "messages") &&
    typeof c.attachments === "boolean" &&
    Array.isArray(c.folders) &&
    typeof c.priorityCount === "number" &&
    typeof c.view === "object" &&
    c.view !== null &&
    typeof list === "object" &&
    list !== null &&
    Array.isArray(list.rows) &&
    Array.isArray(list.pinned) &&
    typeof list.total === "number" &&
    typeof c.savedAt === "number" &&
    now - c.savedAt < MAX_AGE_MS &&
    c.savedAt <= now + 60_000
  );
}

/**
 * The entry for `address` opened with this session's key, or null (none, too old, malformed, another session's, or no
 * storage). One that can't be used is removed.
 */
export async function readCachedView(address: string, cryptoKey: CryptoKey | null): Promise<CachedView | null> {
  if (!cryptoKey) return null;
  try {
    const stored = await withStore<unknown>("readonly", (s) => s.get(key(address)));
    if (stored === null || stored === undefined) return null;
    const v = await openView(stored, cryptoKey, address);
    if (v) return v;
    await withStore("readwrite", (s) => s.delete(key(address)));
    return null;
  } catch {
    return null;
  }
}

/** Stores the entry for its mailbox, sealed (best effort; nothing once any tab has cleared the cache). */
export async function writeCachedView(
  entry: Omit<CachedView, "v" | "savedAt" | "address"> & { address: string },
  cryptoKey: CryptoKey | null,
): Promise<void> {
  if (!cryptoKey || !writesAllowed()) return;
  try {
    const value: CachedView = { ...entry, v: 1, address: key(entry.address), savedAt: Date.now() };
    const sealed = await sealView(value, cryptoKey);
    // Checked again after sealing: a clear in another tab meanwhile wins.
    if (!writesAllowed()) return;
    await withStore("readwrite", (s) => s.put(sealed, value.address));
  } catch {
    // No instant paint next time.
  }
}

/**
 * Removes every entry (sign-out, a mailbox added or switched, a session that ended) and stops every tab of this
 * browser from writing again: the epoch moves and the clear is announced.
 */
export async function clearViewCache(): Promise<void> {
  state.closed = true;
  try {
    globalThis.localStorage.setItem(EPOCH_KEY, String(Number(readEpoch()) + 1));
  } catch {
    // No localStorage: the broadcast below still reaches open tabs.
  }
  try {
    channel?.postMessage("cleared");
  } catch {
    // Channel closed.
  }
  try {
    await withStore("readwrite", (s) => s.clear());
  } catch {
    // Nothing stored, or no storage.
  }
}

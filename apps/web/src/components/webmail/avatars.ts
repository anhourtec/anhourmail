// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Profile photos in the webmail (ADR-0022): the photo of each mailbox signed in to this session (sidebar tiles and
 * header, account switcher, Settings → Account) and, for addresses on screen (message senders, contacts), the photo
 * of a mailbox in the same account. All of them are our own same-origin, versioned URLs; nothing is fetched from
 * anywhere else (rule 29).
 *
 * Kept in sync with the console (rule 61): the list is fetched again when the tab is shown or focused and every few
 * minutes, and right after a change made here. A changed photo has a new URL, so an unchanged one stays cached.
 */

/** `editable`: whether this webmail may change it (a person in more than one account changes theirs in the console). */
export type OwnPhoto = { url: string | null; own: "person" | "mailbox"; editable: boolean };

const REFRESH_MS = 5 * 60_000;
const BATCH_MS = 40;
const MAX_BATCH = 100;

let own = new Map<string, OwnPhoto>();
/** Looked-up addresses: a URL, or null when that address has no photo we may show. */
let found = new Map<string, string | null>();
const queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const norm = (address: string) => address.trim().toLowerCase();

function changed() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function post(addresses: string[]): Promise<Record<string, string>> {
  const res = await fetch("/api/webmail/avatars/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses }),
  });
  if (!res.ok) return {};
  const json = (await res.json().catch(() => null)) as { data?: { avatars?: Record<string, string> } } | null;
  return json?.data?.avatars ?? {};
}

function flush() {
  timer = null;
  const batch = [...queued].slice(0, MAX_BATCH);
  for (const a of batch) queued.delete(a);
  if (queued.size > 0) timer = setTimeout(flush, BATCH_MS);
  if (batch.length === 0) return;
  void post(batch)
    .then((answer) => {
      for (const a of batch) found.set(a, answer[a] ?? null);
      changed();
    })
    // Offline or signed out: initials until the next refresh.
    .catch(() => undefined);
}

function want(address: string) {
  const a = norm(address);
  if (a === "" || found.has(a) || queued.has(a)) return;
  queued.add(a);
  timer ??= setTimeout(flush, BATCH_MS);
}

/** Fetches the session's own photos again and asks again about every address already looked up. */
export async function refreshPhotos(): Promise<void> {
  try {
    const res = await fetch("/api/webmail/avatars");
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as {
        data?: {
          mailboxes?: { address: string; url: string | null; own: "person" | "mailbox"; editable?: boolean }[];
        };
      } | null;
      own = new Map(
        (json?.data?.mailboxes ?? []).map((m) => [
          norm(m.address),
          { url: m.url, own: m.own, editable: m.editable === true },
        ]),
      );
    }
  } catch {
    // Keep what we had.
  }
  const again = [...found.keys()];
  found = new Map();
  for (const a of again) want(a);
  changed();
}

/** After a change made in Settings: show it at once everywhere in this tab, then refresh the rest. */
export function photoChanged(address: string, url: string | null): void {
  const a = norm(address);
  own.set(a, { url, own: own.get(a)?.own ?? "person", editable: own.get(a)?.editable ?? true });
  found.delete(a);
  changed();
  void refreshPhotos();
}

/**
 * Starts the refreshes (once, from the webmail app): on load, when the tab is shown or focused, and periodically.
 * `ready` false holds the first one back (the app asks for photos once the mail is shown).
 */
export function usePhotoSync(active: string, ready = true): void {
  useEffect(() => {
    if (!ready) return;
    void refreshPhotos();
    const onShow = () => {
      if (document.visibilityState === "visible") void refreshPhotos();
    };
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    const every = setInterval(onShow, REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
      clearInterval(every);
    };
  }, [active, ready]);
}

/** The photo of one of this session's mailboxes, or null (read through the store, so a change re-renders). */
export function useOwnPhoto(address: string): OwnPhoto | null {
  const a = norm(address);
  const get = () => own.get(a) ?? null;
  return useSyncExternalStore(subscribe, get, () => null);
}

/**
 * The photo for an address on screen: a session mailbox's own, else (looked up in batches) a mailbox in the same
 * account; null when there is none, so the caller shows initials.
 */
export function usePhoto(address: string | undefined): string | null {
  const a = address ? norm(address) : "";
  useEffect(() => {
    if (a !== "" && !own.has(a)) want(a);
  }, [a]);
  const get = () => (a === "" ? null : own.has(a) ? (own.get(a)?.url ?? null) : (found.get(a) ?? null));
  return useSyncExternalStore(subscribe, get, () => null);
}

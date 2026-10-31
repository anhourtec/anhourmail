// SPDX-License-Identifier: AGPL-3.0-only
import type { Address } from "@/server/webmail/view";

import type { Folder } from "./mail-client";

/**
 * How often the open, visible webmail asks the mail server what changed (one cheap JMAP request carrying
 * `Email/changes` and `Mailbox/changes`).
 */
export const POLL_MS = 30_000;
/** The longest wait after repeated failures. */
export const MAX_POLL_MS = 5 * 60_000;

/** The wait before the next check: every 30 s, doubling after each failure in a row up to 5 minutes. */
export function pollDelay(failures: number, base = POLL_MS, max = MAX_POLL_MS): number {
  if (failures <= 0) return base;
  return Math.min(max, base * 2 ** Math.min(failures, 10));
}

/** Whether to check now: only while the tab is visible and the browser is online. */
export function shouldPoll(visibility: DocumentVisibilityState, online: boolean): boolean {
  return visibility === "visible" && online;
}

/** How long after a change the folder counts reload: changes made close together share one reload. */
export const FOLDER_RELOAD_MS = 300;

/**
 * Runs `run` once, `delayMs` after the first `schedule()` call; every further call before then shares that run.
 * A call while the run is in flight runs it once more when it finishes (its answer may predate that change), so
 * there is never more than one run in flight and the last change is always followed by a run. `cancel()` stops
 * anything waiting (the page is closing).
 */
export function coalescer(run: () => Promise<unknown>, delayMs: number): { schedule: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let cancelled = false;
  const fire = async () => {
    timer = undefined;
    running = true;
    try {
      await run();
    } catch {
      // The run reports its own errors; the next change schedules another.
    } finally {
      running = false;
    }
    if (again && !cancelled) {
      again = false;
      schedule();
    }
  };
  function schedule() {
    if (cancelled) return;
    if (running) {
      again = true;
      return;
    }
    timer ??= setTimeout(() => void fire(), delayMs);
  }
  return {
    schedule,
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * The first paint's order (docs/internal/05-webmail.md "First load"): this browser's copy of the first view
 * (`cached`) is shown only if it arrives before the server's answer (`fresh`), which is always shown when it comes. If
 * the server's answer fails, `fallback` runs (the step-by-step load) — unless `fatal` says the failure ends things
 * (signed out), when it is rethrown. Nothing is shown once `live()` is false (the page went away).
 */
export async function raceFirstPaint<C, F>(o: {
  cached: Promise<C | null> | null;
  fresh: Promise<F>;
  showCached: (c: C) => void;
  showFresh: (f: F) => void;
  fallback: () => Promise<void>;
  fatal: (err: unknown) => boolean;
  live: () => boolean;
}): Promise<void> {
  let settled = false;
  void o.cached?.then(
    (c) => {
      if (c !== null && !settled && o.live()) o.showCached(c);
    },
    () => undefined,
  );
  let f: F;
  try {
    f = await o.fresh;
  } catch (err) {
    settled = true;
    if (!o.live()) return;
    if (o.fatal(err)) throw err;
    await o.fallback();
    return;
  }
  settled = true;
  if (o.live()) o.showFresh(f);
}

/**
 * The folder counts right after marking messages read (`seen` true) or unread, before the server's own counts
 * arrive: each message whose read state flips moves its folders' unread count by one. Messages not in `emails`
 * (not loaded in the list) are left to the reload that follows.
 */
export function adjustUnread(
  folders: Folder[],
  emails: { mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }[],
  seen: boolean,
): Folder[] {
  const delta = new Map<string, number>();
  for (const e of emails) {
    if ((e.keywords.$seen === true) === seen) continue;
    for (const [id, inIt] of Object.entries(e.mailboxIds)) {
      if (inIt) delta.set(id, (delta.get(id) ?? 0) + (seen ? -1 : 1));
    }
  }
  if (delta.size === 0) return folders;
  return folders.map((f) => {
    const d = delta.get(f.id);
    return d === undefined ? f : { ...f, unreadEmails: Math.max(0, f.unreadEmails + d) };
  });
}

type Created = {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
};

/**
 * The new messages worth a chime: unread, in the Inbox, not in Junk, not a draft and not from your own addresses.
 * Nothing on the first check (that's the mail already there when the page opened).
 */
export function newMailToAnnounce<T extends Created>(
  created: T[],
  ctx: { inboxId: string | undefined; junkId: string | undefined; mine: ReadonlySet<string>; firstCheck: boolean },
): T[] {
  if (ctx.firstCheck || !ctx.inboxId) return [];
  const inbox = ctx.inboxId;
  return created.filter(
    (e) =>
      e.mailboxIds[inbox] === true &&
      !(ctx.junkId && e.mailboxIds[ctx.junkId]) &&
      e.keywords.$seen !== true &&
      e.keywords.$draft !== true &&
      !ctx.mine.has((e.from?.[0]?.email ?? "").toLowerCase()),
  );
}

/**
 * The tab title: "(3) Inbox · AnhourMail" with unread Inbox mail, else "Inbox · AnhourMail" (the view shown). A tab
 * showing a mailbox shared with the person names that mailbox instead: "desk@example.com · Inbox".
 */
export function tabTitle(view: string | null, unread: number, opts: { mailbox?: string } = {}): string {
  const base = opts.mailbox
    ? view
      ? `${opts.mailbox} · ${view}`
      : opts.mailbox
    : view
      ? `${view} · AnhourMail`
      : "AnhourMail";
  return unread > 0 ? `(${String(unread)}) ${base}` : base;
}

/**
 * A short, soft two-note chime made with Web Audio (no file, no network). Silently does nothing when the browser
 * blocks audio until the person has interacted with the page.
 */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext;
    const ctx = new Ctx();
    if (ctx.state === "suspended") {
      void ctx.close();
      return;
    }
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.06, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    }
    window.setTimeout(() => void ctx.close(), 800);
  } catch {
    // No audio available: new mail is still shown.
  }
}

/** The browser's answer about desktop notifications, or `unsupported` when it has none. */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

/**
 * What to tell the person when desktop notifications can't be turned on, or null when they can. A browser that
 * blocked them won't ask again: only the site settings can allow them.
 */
export function notificationHelp(permission: NotifyPermission): string | null {
  switch (permission) {
    case "granted":
      return null;
    case "denied":
      return "Your browser is blocking notifications from this site. To allow them, open the site settings (the icon at the left of the address bar), set Notifications to Allow, then turn this on again.";
    case "default":
      return "Your browser didn't allow notifications. Turn this on again and choose Allow when it asks.";
    case "unsupported":
      return "This browser can't show desktop notifications.";
  }
}

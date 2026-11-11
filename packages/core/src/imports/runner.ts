// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The importer's work (ADR-0030 §5, §6, §7, §19): claim an import, run one slice of it, checkpoint, give it back.
 *
 * - **Claims and leases:** `claim` takes the oldest due import within the per-account and global caps and gives it a
 *   fresh lease token; the lease is renewed every `renewEveryMs` while the slice runs, and every progress write is
 *   conditional on the token, so a runner that lost its lease (killed, stalled, or the import was cancelled) stops at
 *   once and writes nothing more.
 * - **Slices:** at most `sliceMs` per claim, then a checkpoint and `run_after = now`, so accounts take turns.
 * - **Checkpoints:** per source folder its UIDVALIDITY and last UID (and counts), written at most every
 *   `checkpointEveryMs` or `checkpointEveryMessages`. A crash between an APPEND and its checkpoint re-reads that message
 *   next time and the dedupe index skips it: at-least-once copy, exactly-once result. A changed UIDVALIDITY restarts
 *   that folder from the start (dedupe again protects).
 * - **Mail in memory only:** one message at a time, never on disk, in Postgres or in a log; the destination's dedupe
 *   keys live for one slice. Nothing here logs anything but ids and codes.
 * - **Spam training (ADR-0030 update 2026-11-05):** nothing is ever appended into the destination's Junk folder
 *   (`folders.ts`), spam-training keywords are dropped, and each slice that appended anything queues
 *   `mail_import.training_cleanup` for its window, so the worker's training key removes the ham samples the APPENDs
 *   created (a slice whose runner died is covered when the import is next claimed: its abandoned lease bounds the
 *   window). A message cap by trust tier (`messageCap`, from configuration) bounds what imports add to one mailbox
 *   over a rolling `CAP_WINDOW_MS` (30 days), counted across its imports so restarting one can't reset it.
 */
import { randomUUID } from "node:crypto";

import {
  IMPORT,
  IMPORT_DROPPED_KEYWORDS,
  IMPORT_SYSTEM_FLAGS,
  type ImportBlockedReason,
} from "@anhourmail/shared/import";

import type { Actor } from "../actor";
import type { Mailbox } from "../mailboxes/entity";
import { recordSystemChanges, type SystemChange } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { mailboxTier } from "../trust/standing";
import { dedupeKey, importMarkerLine } from "./dedupe";
import type { MailImport, MailImportFolder, MailImportPatch } from "./entity";
import { isJunkDestination, planFolders } from "./folders";
import { endImport, queueLeaseCleanup } from "./lifecycle";
import {
  type DestinationFolder,
  type DestinationSession,
  ImportConnectError,
  ImportSessionError,
  type MailDestination,
  type MailSource,
  type SourceFolder,
  type SourceMessageMeta,
  type SourceSession,
} from "./ports";
import { type ImportSealer, openDestinationSecret, openFolderPath, openSourceSecret, sealFolderPath } from "./secrets";
import { mailboxImportable } from "./service";

export type RunnerConfig = {
  /** Longest a runner keeps one import before giving it back (`IMPORT_SLICE_MINUTES`). */
  sliceMs: number;
  /** Lease length and how often it is renewed (well inside it). */
  leaseMs: number;
  renewEveryMs: number;
  /** Per-import throttles (`IMPORT_MAX_MESSAGES_PER_SECOND`, `IMPORT_MAX_BYTES_PER_SECOND`). */
  maxMessagesPerSecond: number;
  maxBytesPerSecond: number;
  /** Largest message copied (`IMPORT.maxMessageBytes`; tests lower it). */
  maxMessageBytes: number;
  /** Caps on imports holding a live lease: per account (`IMPORT.perAccountConcurrency`) and overall. */
  perAccount: number;
  global: number;
  /** Checkpoint at most this often (time or messages). */
  checkpointEveryMs: number;
  checkpointEveryMessages: number;
  /** Re-check the mailbox can still take mail every this many messages. */
  gateEveryMessages: number;
  /**
   * Most messages imports may copy into one mailbox in `CAP_WINDOW_MS` when the mailbox has this effective trust tier
   * (its account's, `restricted` while staff restrict it; ADR-0034 step B) (configuration; null: no cap).
   */
  messageCap: (tier: string) => number | null;
  /** Consecutive transient failures before an import waits for the person. */
  maxAttempts: number;
  /** Wait before a training-sample cleanup runs after its slice (the server writes samples a moment later). */
  trainingCleanupDelayMs: number;
};

/** The rolling window the per-mailbox message cap counts over. */
export const CAP_WINDOW_MS = 30 * 86_400_000;

export const DEFAULT_RUNNER_CONFIG: Omit<RunnerConfig, "messageCap" | "global"> = {
  sliceMs: 15 * 60_000,
  leaseMs: 2 * 60_000,
  renewEveryMs: 30_000,
  maxMessagesPerSecond: 20,
  maxBytesPerSecond: 10_000_000,
  maxMessageBytes: IMPORT.maxMessageBytes,
  perAccount: IMPORT.perAccountConcurrency,
  checkpointEveryMs: 2000,
  checkpointEveryMessages: 20,
  gateEveryMessages: 500,
  maxAttempts: 10,
  trainingCleanupDelayMs: 60_000,
};

export type RunnerPorts = {
  source: MailSource;
  destination: MailDestination;
  sealer: ImportSealer;
  /** Waits (tests pass a fake that only advances their clock). */
  sleep?: (ms: number) => Promise<void>;
};

/** How a slice ended (for the importer's log: codes and counts only). */
export type SliceOutcome = {
  importId: string;
  outcome: "released" | "paused" | "blocked" | "syncing" | "completed" | "failed" | "retry" | "lease_lost";
  reason: string | null;
  appended: number;
};

const SYSTEM: Actor = { kind: "system", name: "importer" };
const reqOf = (importId: string): RequestMeta => ({ requestId: `import-${importId}`, ip: null, userAgent: null });

/** Back-off after a transient failure: 1, 2, 4 … 30 minutes. */
export const importBackoffMs = (attempt: number): number => Math.min(30, 2 ** Math.max(0, attempt - 1)) * 60_000;

const ATOM = /^[!#$&'+\-.0-9<>?@A-Z^_`a-z|~]+$/;

/**
 * The flags an APPEND keeps (ADR-0030 §5): the system flags `\Seen \Answered \Flagged \Draft`, and valid keywords
 * (an atom of at most `IMPORT.maxKeywordLength` characters, at most `IMPORT.maxKeywords`). `\Recent` and other
 * system flags are dropped, and so are the spam-training keywords (`IMPORT_DROPPED_KEYWORDS`): folder placement says
 * that, and the mail server trains on them. `deleted` for a message flagged `\Deleted` (never copied).
 */
export function appendFlags(flags: readonly string[]): string[] | "deleted" {
  const dropped = new Set(IMPORT_DROPPED_KEYWORDS.map((k) => k.toLowerCase()));
  const system = new Map(IMPORT_SYSTEM_FLAGS.map((f) => [f.toLowerCase(), f] as const));
  const out: string[] = [];
  const seen = new Set<string>();
  let keywords = 0;
  for (const raw of flags) {
    const f = raw.trim();
    const key = f.toLowerCase();
    if (key === "\\deleted") return "deleted";
    if (seen.has(key)) continue;
    if (f.startsWith("\\")) {
      const known = system.get(key);
      if (known) {
        out.push(known);
        seen.add(key);
      }
      continue;
    }
    if (dropped.has(key) || !ATOM.test(f) || f.length > IMPORT.maxKeywordLength || keywords >= IMPORT.maxKeywords) {
      continue;
    }
    out.push(f);
    seen.add(key);
    keywords += 1;
  }
  return out;
}

/** The message as appended: our marker line on top, the original bytes unchanged below it. */
export function withMarker(importId: string, raw: Uint8Array): Uint8Array {
  const marker = new TextEncoder().encode(importMarkerLine(importId));
  const out = new Uint8Array(marker.byteLength + raw.byteLength);
  out.set(marker, 0);
  out.set(raw, marker.byteLength);
  return out;
}

/** A connect failure as the blocked reason it means, or null for a transient one (retried). */
function connectBlock(side: "source" | "destination", err: ImportConnectError): ImportBlockedReason | null {
  if (side === "destination") return err.code === "auth" ? "destination_credential" : null;
  switch (err.code) {
    case "auth":
      return "source_auth";
    case "certificate":
      return "source_certificate";
    case "tls_required":
      return "source_tls_required";
    case "blocked_address":
    case "bad_host":
    case "bad_port":
      return "source_unreachable";
    case "unreachable":
      return null;
  }
}

class LeaseLost extends Error {
  constructor() {
    super("import lease lost");
    this.name = "LeaseLost";
  }
}

/** Stop copying here: the outcome is decided by `kind`. */
class Stop extends Error {
  constructor(
    readonly kind: "slice" | "pause" | "over_quota" | "mailbox" | "cap",
    message = kind,
  ) {
    super(message);
    this.name = "Stop";
  }
}

type FolderState = MailImportFolder & { path: string; destination: string | null };

/**
 * Claims the next due import and runs one slice of it. Null when nothing is due. Never throws for an import's own
 * failures (they become its state); throws only when Postgres itself fails (the importer then exits and restarts).
 */
export async function runNextImportSlice(
  deps: Deps,
  ports: RunnerPorts,
  config: RunnerConfig,
): Promise<SliceOutcome | null> {
  const token = randomUUID();
  const claim = await deps.uow.run((r) =>
    r.imports.claim(deps.clock.now(), {
      token,
      leaseMs: config.leaseMs,
      perAccount: config.perAccount,
      global: config.global,
    }),
  );
  if (!claim) return null;
  const { abandonedLeaseUntil, ...row } = claim;
  if (abandonedLeaseUntil !== null) {
    // The last runner died mid-slice without queuing its clean-up: cover everything it could have appended.
    await deps.uow.run((r) =>
      queueLeaseCleanup(r, row.id, abandonedLeaseUntil, abandonedLeaseUntil, {
        leaseMs: config.leaseMs,
        sliceMs: config.sliceMs,
      }),
    );
  }
  return runImportSlice(deps, ports, config, row, token);
}

/** One slice of a claimed import (`runNextImportSlice` = claim + this; exported for tests). */
export async function runImportSlice(
  deps: Deps,
  ports: RunnerPorts,
  config: RunnerConfig,
  claim: MailImport,
  token: string,
): Promise<SliceOutcome> {
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = deps.clock.now();
  const abort = new AbortController();
  const id = claim.id;
  let appended = 0;
  /** Set from the renewal timer; read through the object so the checks after an await aren't narrowed away. */
  const lease = { lost: false };

  const outcome = (o: SliceOutcome["outcome"], reason: string | null = null): SliceOutcome => ({
    importId: id,
    outcome: o,
    reason,
    appended,
  });

  // The lease is renewed in the background; losing it aborts every connection of this slice.
  const renew = setInterval(() => {
    void deps.uow
      .run((r) => r.imports.renewLease(id, token, new Date(deps.clock.now().getTime() + config.leaseMs)))
      .then((held) => {
        if (!held) {
          lease.lost = true;
          abort.abort();
        }
      })
      .catch(() => {
        lease.lost = true;
        abort.abort();
      });
  }, config.renewEveryMs);
  renew.unref();

  let currentFolder: FolderState | null = null;
  /** A forced checkpoint of one folder (lease-conditional; false when the lease is gone). */
  let saveProgress: (f: FolderState) => Promise<boolean> = async () => false;
  /** Every session this slice opened, closed in `finally`. */
  const sessions: { close(): Promise<void> }[] = [];
  const totals = {
    messagesDone: claim.messagesDone,
    bytesDone: claim.bytesDone,
    duplicates: claim.duplicates,
    tooLarge: claim.tooLarge,
    failed: claim.failed,
  };

  /** Queues the training-sample cleanup for this slice's window (in the caller's unit of work). */
  const queueTrainingCleanup = async (r: Repositories) => {
    if (appended === 0) return;
    const end = deps.clock.now();
    await r.provisioning.enqueue({
      kind: "mail_import.training_cleanup",
      subjectId: `${id}:${String(startedAt.getTime())}:${String(end.getTime())}`,
      runAfter: new Date(end.getTime() + config.trainingCleanupDelayMs),
    });
  };

  /** Gives the import back with `patch` and records `audit` with it, in one unit of work. False: lease lost. */
  const release = async (patch: MailImportPatch, audit: SystemChange[] = []): Promise<boolean> =>
    deps.uow.run(async (r) => {
      if (!(await r.imports.release(id, token, { ...totals, ...patch }))) return false;
      await queueTrainingCleanup(r);
      await recordSystemChanges(deps, r, SYSTEM as Extract<Actor, { kind: "system" }>, reqOf(id), audit);
      return true;
    });

  const auditEntry = (action: SystemChange["action"], meta: Record<string, unknown>): SystemChange => ({
    action,
    accountId: claim.accountId,
    target: { type: "mail_import", id },
    meta: { importId: id, mailboxId: claim.mailboxId, ...meta },
  });

  const block = async (reason: ImportBlockedReason, extra: Record<string, unknown> = {}): Promise<SliceOutcome> => {
    const done = await release({ status: "blocked", blockedReason: reason, attempts: 0 }, [
      auditEntry("data.import_blocked", { reason, ...extra }),
    ]);
    return done ? outcome("blocked", reason) : outcome("lease_lost");
  };

  const finish = async (
    status: "completed" | "failed",
    errorCode: string | null,
    extra: SystemChange[] = [],
  ): Promise<SliceOutcome> =>
    deps.uow.run(async (r) => {
      const current = await r.imports.getById(id);
      if (current?.leaseToken !== token) return outcome("lease_lost");
      await r.imports.progress(id, token, { ...totals, attempts: 0 });
      const ended = await endImport(r, id, { status, at: deps.clock.now(), errorCode, ownLease: token });
      if (!ended) return outcome("lease_lost");
      await queueTrainingCleanup(r);
      await recordSystemChanges(deps, r, SYSTEM as Extract<Actor, { kind: "system" }>, reqOf(id), [
        ...extra,
        auditEntry("data.import_finished", {
          status,
          errorCode,
          messagesDone: ended.messagesDone,
          duplicates: ended.duplicates,
          tooLarge: ended.tooLarge,
          failed: ended.failed,
          bytesDone: ended.bytesDone,
        }),
      ]);
      return outcome(status, errorCode);
    });

  const retry = async (code: string): Promise<SliceOutcome> => {
    const attempts = claim.attempts + 1;
    if (attempts >= config.maxAttempts) return block("source_unreachable", { attempts });
    const done = await release({
      attempts,
      errorCode: code,
      runAfter: new Date(deps.clock.now().getTime() + importBackoffMs(attempts)),
    });
    return done ? outcome("retry", code) : outcome("lease_lost");
  };

  try {
    // The mailbox must still be able to take mail (suspended, deleting, handed over: stop).
    const gate = async (): Promise<Mailbox | null> => {
      const m = await deps.uow.run((r) => r.mailboxes.get(claim.accountId, claim.mailboxId));
      return m && mailboxImportable(m) ? m : null;
    };
    const mailbox = await gate();
    if (!mailbox) return await block("mailbox_unavailable");

    if (claim.sourceSecret === null || claim.destinationSecret === null || claim.sourceUsername === null) {
      return await finish("failed", "secret_unreadable");
    }
    let sourceSecret: string;
    let destinationSecret: string;
    try {
      sourceSecret = openSourceSecret(ports.sealer, id, claim.sourceSecret);
      destinationSecret = openDestinationSecret(ports.sealer, id, claim.destinationSecret);
    } catch {
      return await finish("failed", "secret_unreadable");
    }

    // The destination mailbox's effective tier (its account's, restricted while staff restrict it; ADR-0034 step B).
    const tier = await deps.uow.run((r) => mailboxTier(r, claim.accountId, claim.mailboxId));
    const tierCap = config.messageCap(tier);
    // What the mailbox's other imports of the window copied already counts against it (SA-65-05).
    const copiedElsewhere =
      tierCap === null
        ? 0
        : await deps.uow.run((r) =>
            r.imports.messagesCopiedInto(
              claim.mailboxId,
              new Date(deps.clock.now().getTime() - CAP_WINDOW_MS),
              claim.id,
            ),
          );
    const cap = tierCap === null ? null : Math.max(0, tierCap - copiedElsewhere);
    if (cap !== null && totals.messagesDone >= cap) return await finish("completed", "message_cap");

    let source: SourceSession;
    try {
      source = await ports.source.connect(
        { host: claim.sourceHost, port: claim.sourcePort },
        { kind: "password", username: claim.sourceUsername, secret: sourceSecret },
        abort.signal,
      );
    } catch (err) {
      if (err instanceof ImportConnectError) {
        const reason = connectBlock("source", err);
        return await (reason ? block(reason) : retry(`source_${err.code}`));
      }
      return await retry("source_unreachable");
    }
    sessions.push(source);
    let dest: DestinationSession;
    try {
      dest = await ports.destination.connect(mailbox.address, destinationSecret, abort.signal);
    } catch (err) {
      if (err instanceof ImportConnectError && connectBlock("destination", err)) {
        return await block("destination_credential");
      }
      return await retry("destination_unreachable");
    }
    sessions.push(dest);

    // ---- planning: the folder list, new folders recorded (sealed paths), totals, the quota check ----
    const firstPlan = claim.phase === null && (await deps.uow.run((r) => r.imports.folders(id))).length === 0;
    if (claim.phase === null) {
      if (!(await deps.uow.run((r) => r.imports.progress(id, token, { phase: "verifying" })))) throw new LeaseLost();
    }
    const sourceFolders = await source.folders();
    const destFolders = await dest.folders();
    const folders = await recordPlan(deps, ports.sealer, claim, token, sourceFolders, destFolders);
    const live = folders.filter((f) => f.destination !== null);
    const sizeOf = (f: SourceFolder) => f.sizeBytes ?? 0;
    const planned = {
      foldersTotal: folders.length,
      messagesTotal: sourceFolders
        .filter((f) => live.some((l) => l.path === f.path))
        .reduce((n, f) => n + (f.messages ?? 0), 0),
      bytesTotal: sourceFolders.filter((f) => live.some((l) => l.path === f.path)).reduce((n, f) => n + sizeOf(f), 0),
    };
    if (!(await deps.uow.run((r) => r.imports.progress(id, token, { ...planned, phase: "copying" })))) {
      throw new LeaseLost();
    }
    if (firstPlan && planned.bytesTotal > 0) {
      const q = await dest.quota();
      if (q.limitBytes !== null && planned.bytesTotal > q.limitBytes - q.usedBytes) {
        return await block("quota_full", { bytesTotal: planned.bytesTotal, freeBytes: q.limitBytes - q.usedBytes });
      }
    }

    // ---- copying ----
    const sliceEnds = startedAt.getTime() + config.sliceMs;
    const indexes = new Map<string, Set<string>>();
    const indexOf = async (path: string): Promise<Set<string>> => {
      const key = path.toLowerCase();
      const known = indexes.get(key);
      if (known) return known;
      const made = await dest.index(path);
      indexes.set(key, made);
      return made;
    };
    let pending = 0;
    let lastCheckpoint = deps.clock.now().getTime();
    let sinceGate = 0;
    let rateStart = deps.clock.now().getTime();
    let rateMessages = 0;
    let rateBytes = 0;

    const write = (f: FolderState, now: number) => {
      const { path: _path, destination: _dest, ...row } = f;
      return deps.uow.run(async (r) => {
        if (!(await r.imports.saveFolder({ ...row, updatedAt: new Date(now) }, token))) return null;
        if (!(await r.imports.progress(id, token, totals))) return null;
        return r.imports.getById(id);
      });
    };
    saveProgress = async (f) => (await write(f, deps.clock.now().getTime())) !== null;
    const checkpoint = async (f: FolderState, force = false): Promise<void> => {
      const now = deps.clock.now().getTime();
      if (!force && pending < config.checkpointEveryMessages && now - lastCheckpoint < config.checkpointEveryMs) return;
      const saved = await write(f, now);
      if (saved?.leaseToken !== token) throw new LeaseLost();
      pending = 0;
      lastCheckpoint = now;
      if (saved.pauseRequested) throw new Stop("pause");
    };

    const throttle = async (bytes: number) => {
      rateMessages += 1;
      rateBytes += bytes;
      const elapsed = Math.max(1, deps.clock.now().getTime() - rateStart);
      const want = Math.max(
        (rateMessages / config.maxMessagesPerSecond) * 1000,
        (rateBytes / config.maxBytesPerSecond) * 1000,
      );
      if (want > elapsed) await sleep(want - elapsed);
      if (elapsed > 10_000) {
        rateStart = deps.clock.now().getTime();
        rateMessages = 0;
        rateBytes = 0;
      }
    };

    // `\All` (role "all") is de-duplicated against every destination folder: its index is the union.
    const unionIndex = async (): Promise<Set<string>> => {
      const union = new Set<string>();
      for (const f of await dest.folders()) {
        for (const k of await indexOf(f.path)) union.add(k);
      }
      return union;
    };

    for (const f of live) {
      const destination = f.destination;
      if (destination === null) continue;
      // The last check before any APPEND: never into the destination's Junk folder (spam training).
      if (isJunkDestination(destination, destFolders)) {
        f.status = "skipped";
        await checkpoint(f, true);
        continue;
      }
      let opened: { uidValidity: bigint };
      try {
        opened = await source.open(f.path);
      } catch (err) {
        if (err instanceof ImportSessionError && err.code === "refused") {
          // The source won't open this one (gone since the plan): skip it, keep going.
          f.status = "skipped";
          await checkpoint(f, true);
          continue;
        }
        throw err;
      }
      currentFolder = f;
      if (f.uidValidity !== null && f.uidValidity !== opened.uidValidity) f.lastUid = 0n;
      f.uidValidity = opened.uidValidity;
      f.status = "copying";
      try {
        await dest.ensureFolder(destination);
      } catch (err) {
        // A name the destination won't take (refused before or by the server): skip the folder, keep going.
        if (!(err instanceof ImportSessionError && err.code === "refused")) throw err;
        f.status = "skipped";
        await checkpoint(f, true);
        currentFolder = null;
        continue;
      }
      const index = f.role === "all" ? await unionIndex() : await indexOf(destination);
      for (;;) {
        const batch: SourceMessageMeta[] = await source.headers(Number(f.lastUid), 100);
        if (batch.length === 0) break;
        for (const m of batch) {
          if (deps.clock.now().getTime() >= sliceEnds) throw new Stop("slice");
          if (cap !== null && totals.messagesDone >= cap) throw new Stop("cap");
          sinceGate += 1;
          if (sinceGate >= config.gateEveryMessages) {
            sinceGate = 0;
            if (!(await gate())) throw new Stop("mailbox");
          }
          const flags = appendFlags(m.flags);
          const key = dedupeKey(m);
          if (flags === "deleted") {
            // Not copied and not counted: a deleted message isn't part of the mailbox.
          } else if (index.has(key)) {
            f.duplicates += 1;
            totals.duplicates += 1;
          } else if (m.size > config.maxMessageBytes) {
            f.tooLarge += 1;
            totals.tooLarge += 1;
          } else {
            let body: Uint8Array | "too_large" | null;
            try {
              body = await source.body(m.uid, config.maxMessageBytes);
            } catch (err) {
              if (!(err instanceof ImportSessionError && err.code === "refused")) throw err;
              body = null;
            }
            if (body === null) {
              f.failed += 1;
              totals.failed += 1;
            } else if (body === "too_large") {
              f.tooLarge += 1;
              totals.tooLarge += 1;
            } else {
              await throttle(body.byteLength);
              const result = await dest.append(destination, withMarker(id, body), flags, m.internalDate);
              if (result === "over_quota") {
                await checkpoint(f, true);
                throw new Stop("over_quota");
              }
              if (result === "rejected") {
                f.failed += 1;
                totals.failed += 1;
              } else {
                appended += 1;
                index.add(key);
                f.messagesDone += 1;
                f.bytesDone += body.byteLength;
                totals.messagesDone += 1;
                totals.bytesDone += body.byteLength;
              }
            }
          }
          f.lastUid = BigInt(m.uid);
          pending += 1;
          await checkpoint(f);
        }
      }
      f.status = "done";
      await checkpoint(f, true);
      currentFolder = null;
    }

    // ---- the pass is done ----
    const now = deps.clock.now();
    const current = await deps.uow.run((r) => r.imports.getById(id));
    if (current?.leaseToken !== token) throw new LeaseLost();
    if (current.options.sync && current.syncUntil !== null && current.syncUntil.getTime() > now.getTime()) {
      const done = await release({
        status: "syncing",
        lastPassAt: now,
        attempts: 0,
        errorCode: null,
        runAfter: new Date(now.getTime() + IMPORT.syncEveryMinutes * 60_000),
      });
      return done ? outcome("syncing") : outcome("lease_lost");
    }
    // A sync stopped by the person was audited then; one whose window ran out is audited by `job:import-expiry`.
    return await finish("completed", null);
  } catch (err) {
    if (err instanceof LeaseLost || lease.lost) return outcome("lease_lost");
    // Keep the folder's progress so far (the counters already include it); a kill skips this, and dedupe then skips
    // what was appended after the last checkpoint.
    if (currentFolder !== null && !(err instanceof Stop && err.kind === "over_quota")) {
      await saveProgress(currentFolder).catch(() => undefined);
    }
    if (err instanceof Stop) {
      if (err.kind === "slice") {
        const done = await release({ attempts: 0, errorCode: null, runAfter: deps.clock.now() });
        return done ? outcome("released") : outcome("lease_lost");
      }
      if (err.kind === "pause") {
        // Audited when it was asked for (`data.import_paused`); this only carries it out.
        const done = await release({ status: "paused", pauseRequested: false, attempts: 0 });
        return done ? outcome("paused") : outcome("lease_lost");
      }
      if (err.kind === "over_quota") return await block("quota_full");
      if (err.kind === "mailbox") return await block("mailbox_unavailable");
      return await finish("completed", "message_cap");
    }
    if (err instanceof ImportSessionError || err instanceof ImportConnectError) {
      return await retry(err instanceof ImportSessionError ? `session_${err.code}` : `connect_${err.code}`);
    }
    // Anything else (a bug, Postgres): count it as a transient failure if we still can, else let the process restart.
    try {
      return await retry("internal");
    } catch {
      throw err;
    }
  } finally {
    clearInterval(renew);
    abort.abort();
    await Promise.all(sessions.map((s) => s.close().catch(() => undefined)));
  }
}

/**
 * Records the folder plan: folders seen before keep their rows (and checkpoints), new ones are added (each path
 * sealed for its own row), and folders whose destination changed are left alone. Returns every recorded folder with
 * its opened path and destination, in plan order (`\All` last).
 */
async function recordPlan(
  deps: Deps,
  sealer: ImportSealer,
  claim: MailImport,
  token: string,
  source: readonly SourceFolder[],
  dest: readonly DestinationFolder[],
): Promise<FolderState[]> {
  const plan = planFolders(source, dest, claim.options);
  const rows = await deps.uow.run((r) => r.imports.folders(claim.id));
  const known = new Map<string, MailImportFolder>();
  for (const row of rows) {
    if (row.sourcePath === null) continue;
    try {
      known.set(openFolderPath(sealer, claim.id, row.id, row.sourcePath), row);
    } catch {
      // A path that no longer opens is a folder we can't match: it is planned again as new.
    }
  }
  const out: FolderState[] = [];
  for (const p of plan) {
    const existing = known.get(p.sourcePath);
    const now = deps.clock.now();
    const row: MailImportFolder = existing ?? {
      id: randomUUID(),
      importId: claim.id,
      role: p.role,
      sourcePath: null,
      uidValidity: null,
      lastUid: 0n,
      messagesTotal: source.find((f) => f.path === p.sourcePath)?.messages ?? 0,
      messagesDone: 0,
      duplicates: 0,
      tooLarge: 0,
      failed: 0,
      bytesDone: 0,
      status: p.destination === null ? "skipped" : "pending",
      updatedAt: now,
    };
    if (!existing) {
      row.sourcePath = sealFolderPath(sealer, claim.id, row.id, p.sourcePath);
      if (!(await deps.uow.run((r) => r.imports.saveFolder(row, token)))) throw new LeaseLost();
    }
    const state: FolderState = { ...row, path: p.sourcePath, destination: p.destination };
    if (existing?.status === "skipped") state.destination = null;
    out.push(state);
  }
  return out;
}

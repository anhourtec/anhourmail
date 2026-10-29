// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import {
  sameSignatureName,
  SIGNATURE_HTML_MAX,
  SIGNATURE_TEXT_MAX,
  signatureName,
  type SignatureDefaults,
  type SignatureSet,
  WEBMAIL_SIGNATURES,
} from "@anhourmail/shared/signatures";

import type { Actor } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { StoredSignature, WebmailMailbox } from "./settings-repository";

/**
 * A mailbox's named signatures and its two defaults (docs/internal/05-webmail.md "Signatures", ADR-0014). They live in
 * the control plane and belong to the mailbox: any of its sending addresses can use any of them. The caller (the
 * webmail BFF) has already sanitised the HTML and generated the text with the signature sanitiser; this service checks
 * names, counts and sizes again and keeps the defaults consistent. Every change is audited in the owning account's log
 * as the mailbox itself, with no name or content in the entry (only ids, counts and sizes).
 *
 * Each change also says whether the default for new messages changed (`mirror`), so the caller can copy it into the
 * mail server's identities for other mail apps.
 */

export type SignatureContent = { html: string; text: string };

export type SignatureChange = SignatureSet & {
  /** The default for new messages after the change, when it differs from before (null content = none); else undefined. */
  mirror?: SignatureContent | null;
};

const view = (rows: StoredSignature[]): SignatureSet => ({
  signatures: rows.map((r) => ({ id: r.id, name: r.name, html: r.html, text: r.text })),
  defaults: {
    newMessage: rows.find((r) => r.defaultNew)?.id ?? null,
    reply: rows.find((r) => r.defaultReply)?.id ?? null,
  },
});

const newDefault = (rows: StoredSignature[]): SignatureContent | null => {
  const d = rows.find((r) => r.defaultNew);
  return d ? { html: d.html, text: d.text } : null;
};

const sameContent = (a: SignatureContent | null, b: SignatureContent | null) =>
  a === b || (a !== null && b !== null && a.html === b.html && a.text === b.text);

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Content as the BFF prepared it, re-checked against the caps. */
function content(c: SignatureContent): SignatureContent {
  if (typeof c.html !== "string" || typeof c.text !== "string") throw new ValidationError("That signature is empty.");
  if (c.html.length > SIGNATURE_HTML_MAX) {
    throw new ValidationError(
      `A signature can be up to ${String(WEBMAIL_SIGNATURES.signatureKb)} KB, images included.`,
    );
  }
  return { html: c.html, text: c.text.slice(0, SIGNATURE_TEXT_MAX) };
}

function name(input: unknown): string {
  const n = signatureName(input);
  if (n === null) {
    throw new ValidationError(`Give the signature a name of up to ${String(WEBMAIL_SIGNATURES.nameChars)} characters.`);
  }
  return n;
}

export class WebmailSignaturesService {
  constructor(private readonly deps: Deps) {}

  #actor(address: string): Actor {
    return { kind: "system", name: address };
  }

  async #mailbox(address: string): Promise<WebmailMailbox> {
    const key = address.trim().toLowerCase();
    const m = await this.deps.uow.run((r) => r.webmailSettings.mailboxByAddress(key));
    if (!m) throw new NotFoundError();
    return m;
  }

  /** The mailbox's signatures and defaults, and whether its signatures were started yet (see `bringOver`). */
  async list(address: string): Promise<SignatureSet & { started: boolean }> {
    const m = await this.#mailbox(address);
    const [rows, started] = await this.deps.uow.run(async (r) =>
      Promise.all([r.webmailSettings.signatures(m.id), r.webmailSettings.signaturesStarted(m.id)]),
    );
    return { ...view(rows), started };
  }

  /** One change in one transaction, audited; `fn` returns the meta and the result. */
  async #change(
    address: string,
    action: AuditAction,
    req: RequestMeta,
    fn: (repos: Repositories, m: WebmailMailbox, rows: StoredSignature[]) => Promise<Record<string, unknown>>,
  ): Promise<SignatureChange> {
    const m = await this.#mailbox(address);
    return mutation(
      this.deps,
      this.#actor(m.address),
      req,
      {
        action,
        permission: "mailbox.read",
        accountId: m.accountId,
        target: { type: "mailbox", id: m.id, label: m.address },
      },
      async (repos) => {
        // One change per mailbox at a time: the caps below are checked against what this read sees.
        await repos.webmailSettings.lockSignatures(m.id);
        const before = await repos.webmailSettings.signatures(m.id);
        const meta = await fn(repos, m, before);
        await repos.webmailSettings.markSignaturesStarted(m.id, this.deps.clock.now());
        const after = await repos.webmailSettings.signatures(m.id);
        const was = newDefault(before);
        const now = newDefault(after);
        const result: SignatureChange = { ...view(after), ...(sameContent(was, now) ? {} : { mirror: now }) };
        return { result, meta: { ...meta, signatures: after.length } };
      },
    );
  }

  /**
   * Adds a signature. The mailbox's first one becomes the default for new messages and for replies, so adding a
   * signature is enough to start using it.
   */
  async create(
    address: string,
    input: { name: unknown } & SignatureContent,
    req: RequestMeta,
  ): Promise<SignatureChange> {
    const n = name(input.name);
    const c = content(input);
    return this.#change(address, "webmail.signature_added", req, async (repos, m, rows) => {
      if (rows.length >= WEBMAIL_SIGNATURES.perMailbox) {
        throw new ValidationError(`A mailbox can keep up to ${String(WEBMAIL_SIGNATURES.perMailbox)} signatures.`);
      }
      if (rows.some((r) => sameSignatureName(r.name, n))) {
        throw new ConflictError("You already have a signature with that name.");
      }
      fitsMailbox(rows, c.html.length);
      const now = this.deps.clock.now();
      const id = randomUUID();
      const first = rows.length === 0;
      await repos.webmailSettings.insertSignature({
        id,
        mailboxId: m.id,
        accountId: m.accountId,
        name: n,
        ...c,
        defaultNew: first,
        defaultReply: first,
        createdAt: now,
        updatedAt: now,
      });
      return { signature: id, bytes: c.html.length, images: images(c.html), ...(first ? { madeDefault: true } : {}) };
    });
  }

  /** Renames and/or rewrites one of the mailbox's signatures; another mailbox's id is not found. */
  async update(
    address: string,
    id: string,
    input: { name?: unknown } & Partial<SignatureContent>,
    req: RequestMeta,
  ): Promise<SignatureChange> {
    if (!isUuid(id)) throw new NotFoundError();
    const n = input.name === undefined ? undefined : name(input.name);
    const c =
      input.html === undefined || input.text === undefined
        ? undefined
        : content({ html: input.html, text: input.text });
    if (n === undefined && c === undefined) throw new ValidationError("Nothing to change.");
    return this.#change(address, "webmail.signature_changed", req, async (repos, m, rows) => {
      if (!rows.some((r) => r.id === id)) throw new NotFoundError();
      if (n !== undefined && rows.some((r) => r.id !== id && sameSignatureName(r.name, n))) {
        throw new ConflictError("You already have a signature with that name.");
      }
      if (c)
        fitsMailbox(
          rows.filter((r) => r.id !== id),
          c.html.length,
        );
      await repos.webmailSettings.updateSignature(
        m.id,
        id,
        { ...(n !== undefined ? { name: n } : {}), ...(c ?? {}) },
        this.deps.clock.now(),
      );
      return {
        signature: id,
        fields: [...(n !== undefined ? ["name"] : []), ...(c ? ["content"] : [])],
        ...(c ? { bytes: c.html.length, images: images(c.html) } : {}),
      };
    });
  }

  /** Deletes one of the mailbox's signatures; a default it was becomes "(No signature)". */
  async remove(address: string, id: string, req: RequestMeta): Promise<SignatureChange> {
    if (!isUuid(id)) throw new NotFoundError();
    return this.#change(address, "webmail.signature_removed", req, async (repos, m, rows) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new NotFoundError();
      await repos.webmailSettings.deleteSignature(m.id, id);
      return { signature: id, wasDefaultNew: row.defaultNew, wasDefaultReply: row.defaultReply };
    });
  }

  /** Sets the defaults for new messages and for replies and forwards (null = none); ids must be the mailbox's own. */
  async setDefaults(address: string, defaults: SignatureDefaults, req: RequestMeta): Promise<SignatureChange> {
    for (const v of [defaults.newMessage, defaults.reply]) {
      if (v !== null && (typeof v !== "string" || !isUuid(v))) throw new NotFoundError();
    }
    return this.#change(address, "webmail.signature_defaults_changed", req, async (repos, m, rows) => {
      for (const v of [defaults.newMessage, defaults.reply]) {
        if (v !== null && !rows.some((r) => r.id === v)) throw new NotFoundError();
      }
      await repos.webmailSettings.setSignatureDefaults(m.id, defaults);
      return { newMessage: defaults.newMessage !== null, reply: defaults.reply !== null };
    });
  }

  /**
   * Brings the mailbox's old single signature (from before named signatures) over once: as "Signature", the default
   * for both kinds of message. Does nothing when the signatures were started already (one was added, or this ran), so
   * deleting every signature later never brings the old one back. Returns null when there was nothing to do.
   */
  async bringOver(address: string, old: SignatureContent, req: RequestMeta): Promise<SignatureChange | null> {
    const c = content(old);
    if (c.html === "" && c.text.trim() === "") return null;
    const m = await this.#mailbox(address);
    const started = await this.deps.uow.run((r) => r.webmailSettings.signaturesStarted(m.id));
    if (started) return null;
    try {
      return await this.#change(address, "webmail.signature_added", req, async (repos, mb, rows) => {
        if (rows.length > 0 || (await repos.webmailSettings.signaturesStarted(mb.id))) throw new AlreadyStarted();
        const now = this.deps.clock.now();
        const id = randomUUID();
        await repos.webmailSettings.insertSignature({
          id,
          mailboxId: mb.id,
          accountId: mb.accountId,
          name: "Signature",
          ...c,
          defaultNew: true,
          defaultReply: true,
          createdAt: now,
          updatedAt: now,
        });
        return { signature: id, bytes: c.html.length, images: images(c.html), broughtOver: true, madeDefault: true };
      });
    } catch (err) {
      // Another tab brought it over first: nothing to do.
      if (err instanceof AlreadyStarted) return null;
      throw err;
    }
  }
}

/** Raced by another request that started the signatures first (rolled back, not shown to anyone). */
class AlreadyStarted extends ConflictError {
  constructor() {
    super("Signatures were already started.");
  }
}

const images = (html: string) => html.match(/<img\b/gi)?.length ?? 0;

/** All of a mailbox's signatures together stay within `mailboxKb` (they load with the webmail). */
function fitsMailbox(others: StoredSignature[], adding: number): void {
  const total = others.reduce((n, r) => n + r.html.length, adding);
  if (total > WEBMAIL_SIGNATURES.mailboxKb * 1024) {
    throw new ValidationError(
      `Your signatures together can be up to ${String(WEBMAIL_SIGNATURES.mailboxKb / 1024)} MB. Make one smaller or delete one.`,
    );
  }
}

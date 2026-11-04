// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import {
  sameTemplateName,
  TEMPLATE_HTML_MAX,
  TEMPLATE_TEXT_MAX,
  templateName,
  type TemplateView,
  WEBMAIL_TEMPLATES,
} from "@anhourmail/shared/templates";

import type { Actor } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { StoredTemplate, WebmailMailbox } from "./settings-repository";

/**
 * A mailbox's templates (canned replies, ADR-0032 §3), kept in the control plane like its signatures. The webmail BFF
 * has sanitised the HTML (no images) and generated the text; this service checks names, the count and the size again.
 * Every change is audited in the owning account's log as the mailbox itself, with ids and sizes only — never a name
 * or any text (rule 48).
 */

export type TemplateContent = { html: string; text: string };

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const view = (rows: StoredTemplate[]): TemplateView[] =>
  rows.map((r) => ({ id: r.id, name: r.name, html: r.html, text: r.text }));

function name(input: unknown): string {
  const n = templateName(input);
  if (n === null) {
    throw new ValidationError(`Give the template a name of up to ${String(WEBMAIL_TEMPLATES.nameChars)} characters.`);
  }
  return n;
}

function content(c: TemplateContent): TemplateContent {
  if (typeof c.html !== "string" || typeof c.text !== "string" || c.html.trim() === "") {
    throw new ValidationError("Write the template's text.");
  }
  if (c.html.length > TEMPLATE_HTML_MAX) {
    throw new ValidationError(`A template can be up to ${String(WEBMAIL_TEMPLATES.templateKb)} KB.`);
  }
  return { html: c.html, text: c.text.slice(0, TEMPLATE_TEXT_MAX) };
}

export class WebmailTemplatesService {
  constructor(private readonly deps: Deps) {}

  #actor(address: string): Actor {
    return { kind: "system", name: address };
  }

  async #mailbox(address: string): Promise<WebmailMailbox> {
    const m = await this.deps.uow.run((r) => r.webmailSettings.mailboxByAddress(address.trim().toLowerCase()));
    if (!m) throw new NotFoundError();
    return m;
  }

  async list(address: string): Promise<TemplateView[]> {
    const m = await this.#mailbox(address);
    return view(await this.deps.uow.run((r) => r.webmailSettings.templates(m.id)));
  }

  async #change(
    address: string,
    action: AuditAction,
    req: RequestMeta,
    fn: (repos: Repositories, m: WebmailMailbox, rows: StoredTemplate[]) => Promise<Record<string, unknown>>,
  ): Promise<TemplateView[]> {
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
        await repos.webmailSettings.lockTemplates(m.id);
        const meta = await fn(repos, m, await repos.webmailSettings.templates(m.id));
        const after = await repos.webmailSettings.templates(m.id);
        return { result: view(after), meta: { ...meta, templates: after.length } };
      },
    );
  }

  async create(address: string, input: { name: unknown } & TemplateContent, req: RequestMeta): Promise<TemplateView[]> {
    const n = name(input.name);
    const c = content(input);
    return this.#change(address, "webmail.template_added", req, async (repos, m, rows) => {
      if (rows.length >= WEBMAIL_TEMPLATES.perMailbox) {
        throw new ValidationError(`A mailbox can keep up to ${String(WEBMAIL_TEMPLATES.perMailbox)} templates.`);
      }
      if (rows.some((r) => sameTemplateName(r.name, n))) {
        throw new ConflictError("You already have a template with that name.");
      }
      const now = this.deps.clock.now();
      const id = randomUUID();
      await repos.webmailSettings.insertTemplate({
        id,
        mailboxId: m.id,
        accountId: m.accountId,
        name: n,
        ...c,
        createdAt: now,
        updatedAt: now,
      });
      return { template: id, bytes: c.html.length };
    });
  }

  /** Renames and/or rewrites one of the mailbox's templates; another mailbox's id is not found. */
  async update(
    address: string,
    id: string,
    input: { name?: unknown } & Partial<TemplateContent>,
    req: RequestMeta,
  ): Promise<TemplateView[]> {
    if (!isUuid(id)) throw new NotFoundError();
    const n = input.name === undefined ? undefined : name(input.name);
    const c =
      input.html === undefined || input.text === undefined
        ? undefined
        : content({ html: input.html, text: input.text });
    if (n === undefined && c === undefined) throw new ValidationError("Nothing to change.");
    return this.#change(address, "webmail.template_changed", req, async (repos, m, rows) => {
      if (!rows.some((r) => r.id === id)) throw new NotFoundError();
      if (n !== undefined && rows.some((r) => r.id !== id && sameTemplateName(r.name, n))) {
        throw new ConflictError("You already have a template with that name.");
      }
      await repos.webmailSettings.updateTemplate(
        m.id,
        id,
        { ...(n !== undefined ? { name: n } : {}), ...(c ?? {}) },
        this.deps.clock.now(),
      );
      return { template: id, ...(c ? { bytes: c.html.length } : {}), renamed: n !== undefined };
    });
  }

  async remove(address: string, id: string, req: RequestMeta): Promise<TemplateView[]> {
    if (!isUuid(id)) throw new NotFoundError();
    return this.#change(address, "webmail.template_removed", req, async (repos, m) => {
      if (!(await repos.webmailSettings.deleteTemplate(m.id, id))) throw new NotFoundError();
      return { template: id };
    });
  }
}

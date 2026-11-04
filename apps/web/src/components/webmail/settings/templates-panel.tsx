// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { type SyntheticEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";
import { sameTemplateName, templateName, type TemplateView, WEBMAIL_TEMPLATES } from "@anhourmail/shared/templates";

import type * as TemplateModule from "@/server/webmail/template-html";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

import { ConfirmDialog, Modal } from "../dialogs";
import { type MailClient, RefusedError } from "../mail-client";
import { RichEditor, useOutgoing } from "../rich-editor";
import { fieldClass, smallSecondary } from "./controls";

/**
 * Settings → Writing → Templates (canned replies, ADR-0032 §3): the mailbox's templates with Edit and Delete, and
 * "Add template". Text only: images are removed on save. Inserted from the composer's Templates menu.
 */

let templateModule: Promise<typeof TemplateModule> | null = null;
const loadTemplateModule = () => (templateModule ??= import("@/server/webmail/template-html"));

const messageOf = (err: unknown) =>
  err instanceof RefusedError ? err.message : "That didn't save. Check your connection and try again.";

/** Sanitiser options in the editor: embedded images only, and none of those (templates keep text). */
const SANITIZE = { embeddedImagesOnly: true, maxDataImage: 0 } as const;

export function TemplatesSection({ client, accountId }: { client: MailClient; accountId: string }) {
  const id = useId();
  const [list, setList] = useState<TemplateView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<TemplateView | "new" | null>(null);
  const [deleting, setDeleting] = useState<TemplateView | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    client
      .templates()
      .then((t) => {
        if (live) setList(t);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [client]);

  const full = list !== null && list.length >= WEBMAIL_TEMPLATES.perMailbox;

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${id}-h`} className="font-medium text-[14px]">
            Templates
          </h3>
          <p className="am-small max-w-prose">
            Text you write often, ready to insert from the Templates button while you write. Templates keep text and
            formatting; images are left out.
          </p>
        </div>
        <button
          type="button"
          disabled={list === null || full}
          onClick={() => {
            setStatus(null);
            setEditing("new");
          }}
          className={smallSecondary}
        >
          <Plus className="size-4" aria-hidden />
          Add template
        </button>
      </div>
      {list === null ? (
        loadError ? (
          <p role="alert" className="am-small text-destructive">
            Your templates couldn&apos;t be loaded. Close and open settings to try again.
          </p>
        ) : (
          <div role="status" aria-busy="true">
            <span className="sr-only">Loading templates</span>
            <Bone className="h-16 w-full rounded-xl" />
          </div>
        )
      ) : (
        <div className="overflow-hidden rounded-xl border">
          {list.length === 0 ? (
            <p className="am-small px-4 py-6 text-center">No templates yet.</p>
          ) : (
            <ul aria-label="Your templates" className="divide-y">
              {list.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2 pr-2 pl-4">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14px]">{t.name}</span>
                    <span className="am-micro truncate">{t.text.slice(0, 120)}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Edit ${t.name}`}
                    title={`Edit ${t.name}`}
                    onClick={() => {
                      setStatus(null);
                      setEditing(t);
                    }}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${t.name}`}
                    title={`Delete ${t.name}`}
                    onClick={() => {
                      setDeleting(t);
                    }}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <span
        aria-live="polite"
        className={`am-small ${status?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {status?.text ?? ""}
      </span>
      {full && (
        <p className="am-micro">{`A mailbox can keep up to ${String(WEBMAIL_TEMPLATES.perMailbox)} templates.`}</p>
      )}
      {editing && (
        <TemplateDialog
          template={editing === "new" ? null : editing}
          taken={(list ?? []).filter((t) => editing === "new" || t.id !== editing.id).map((t) => t.name)}
          onClose={() => {
            setEditing(null);
          }}
          onSave={async (input) => {
            const next =
              editing === "new"
                ? await client.createTemplate(accountId, input)
                : await client.updateTemplate(accountId, editing.id, input);
            setList(next);
            setEditing(null);
            setStatus({ tone: "ok", text: "Template saved." });
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body="Messages you already wrote with it don't change."
          confirm="Delete template"
          onClose={() => {
            setDeleting(null);
          }}
          onConfirm={() => {
            client
              .deleteTemplate(accountId, deleting.id)
              .then((next) => {
                setList(next);
                setStatus({ tone: "ok", text: "Template deleted." });
              })
              .catch((err: unknown) => {
                setStatus({ tone: "error", text: messageOf(err) });
              });
          }}
        />
      )}
    </section>
  );
}

function TemplateDialog({
  template,
  taken,
  onSave,
  onClose,
}: {
  template: TemplateView | null;
  taken: string[];
  onSave: (input: { name: string; html: string }) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const outgoing = useOutgoing();
  const editor = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(template?.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const initialHtml = useMemo(
    () => (outgoing ? outgoing.sanitizeOutgoingHtml(template?.html ?? "", SANITIZE).html : null),
    [outgoing, template],
  );

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    const n = templateName(name);
    if (n === null) {
      setNameError(`Give the template a name of up to ${String(WEBMAIL_TEMPLATES.nameChars)} characters.`);
      return;
    }
    if (taken.some((t) => sameTemplateName(t, n))) {
      setNameError("You already have a template with that name.");
      return;
    }
    const mod = await loadTemplateModule();
    const clean = mod.cleanTemplate(editor.current?.innerHTML ?? "");
    if (clean.problem !== null) {
      setError(clean.problem);
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: n, html: clean.html });
    } catch (err) {
      setError(messageOf(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={template ? "Edit template" : "Add template"} onClose={onClose} size="lg">
      <form onSubmit={(e) => void save(e)} className="flex max-h-[min(40rem,calc(100dvh-8rem))] flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Name</span>
          <input
            autoFocus
            value={name}
            maxLength={WEBMAIL_TEMPLATES.nameChars}
            required
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            placeholder="Thanks, will reply soon"
            className={fieldClass}
          />
          {nameError && (
            <span id={`${id}-name-error`} role="alert" className="am-small text-destructive">
              {nameError}
            </span>
          )}
        </label>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <RichEditor
            editorRef={editor}
            initialHtml={initialHtml}
            outgoing={outgoing}
            onChange={() => {
              setError(null);
            }}
            autoFocus={false}
            id={`${id}-body`}
            label="Template"
            placeholder="The text to insert"
            sanitize={SANITIZE}
            className="min-h-40 flex-1"
          />
        </div>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={saving || initialHtml === null} className={primaryButtonClass}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Copy, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { type SyntheticEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";
import {
  copyName,
  sameSignatureName,
  SIGNATURE_IMAGE_URI_MAX,
  type SignatureDefaults,
  type SignatureSet,
  type SignatureView,
  signatureName,
  WEBMAIL_SIGNATURES,
} from "@anhourmail/shared/signatures";

import type * as SignatureModule from "@/server/webmail/signature-html";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

import { ConfirmDialog, Modal } from "../dialogs";
import { type MailClient, RefusedError, type SignatureResult } from "../mail-client";
import { Menu } from "../menu";
import { RichEditor, useOutgoing } from "../rich-editor";
import { fieldClass, Row, smallPrimary } from "./controls";

/**
 * Settings → Writing → Signatures (docs/internal/05-webmail.md "Signatures"): the mailbox's named signatures in a
 * table (Edit, Delete, and Duplicate under More options), "Add signature", and the two defaults. Every change is saved
 * at once through the BFF, which sanitises it again; the composer gets the new set straight away.
 */

type Status = { tone: "ok" | "error"; text: string } | null;

let signatureModule: Promise<typeof SignatureModule> | null = null;
/** The signature sanitiser (with the outgoing one inside it), loaded on first use. */
const loadSignatureModule = () => (signatureModule ??= import("@/server/webmail/signature-html"));

const messageOf = (err: unknown) =>
  err instanceof RefusedError ? err.message : "That didn't save. Check your connection and try again.";

/** What a saved change means for other mail apps, said only when the default for new messages was involved. */
function savedText(r: SignatureResult, done: string): string {
  if (!r.mirrored)
    return `${done} Other mail apps didn't get the change this time; it will be sent with your next one.`;
  if (r.shortened) return `${done} Other mail apps get a shorter copy without images.`;
  return done;
}

/** The table, the "Add signature" button and the two default pickers. */
export function SignaturesSection({
  client,
  accountId,
  onChanged,
}: {
  client: MailClient;
  accountId: string;
  /** The set changed (the composer uses it). */
  onChanged: (set: SignatureSet) => void;
}) {
  const id = useId();
  const [set, setSet] = useState<SignatureSet | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [editing, setEditing] = useState<SignatureView | "new" | null>(null);
  const [deleting, setDeleting] = useState<SignatureView | null>(null);
  const [busy, setBusy] = useState(false);
  const changedRef = useRef(onChanged);
  useEffect(() => {
    changedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    let live = true;
    client
      .signatures()
      .then((s) => {
        if (!live) return;
        setSet(s);
        changedRef.current(s);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [client]);

  const apply = (r: SignatureResult, done: string) => {
    const next = { signatures: r.signatures, defaults: r.defaults };
    setSet(next);
    onChanged(next);
    setStatus({ tone: "ok", text: savedText(r, done) });
  };

  const run = async (fn: () => Promise<SignatureResult>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      apply(await fn(), done);
      return true;
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setDefault = (kind: keyof SignatureDefaults, value: string) => {
    if (!set) return;
    const defaults = { ...set.defaults, [kind]: value === "" ? null : value };
    void run(() => client.setSignatureDefaults(accountId, defaults), "Default signatures saved.");
  };

  const duplicate = (s: SignatureView) => {
    if (!set) return;
    const name = copyName(
      s.name,
      set.signatures.map((x) => x.name),
    );
    void run(() => client.createSignature(accountId, { name, html: s.html }), `Added “${name}”.`);
  };

  const full = set !== null && set.signatures.length >= WEBMAIL_SIGNATURES.perMailbox;
  const options = useMemo(
    () => [
      { value: "", label: "(No signature)" },
      ...(set?.signatures ?? []).map((s) => ({ value: s.id, label: s.name })),
    ],
    [set],
  );

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${id}-h`} className="font-medium text-[14px]">
            Signatures
          </h3>
          <p className="am-small max-w-prose">
            Create signatures and choose which one new messages and replies start with. They belong to this mailbox and
            work with any of its addresses; switch or remove one while you write. Mail apps on your phone or computer
            keep their own.
          </p>
        </div>
        <button
          type="button"
          disabled={set === null || full || busy}
          onClick={() => {
            setStatus(null);
            setEditing("new");
          }}
          className={smallPrimary}
        >
          <Plus className="size-4" aria-hidden />
          Add signature
        </button>
      </div>

      {set === null ? (
        loadError ? (
          <p role="alert" className="am-small text-destructive">
            Your signatures couldn&apos;t be loaded. Close and open settings to try again.
          </p>
        ) : (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading signatures</span>
            <Bone className="h-[8.5rem] w-full rounded-xl" />
            <Bone className="h-[6.5rem] w-full rounded-xl" />
          </div>
        )
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border">
            {set.signatures.length === 0 ? (
              <p className="am-small px-4 py-6 text-center">No signatures yet. Add one to sign your messages.</p>
            ) : (
              <table className="w-full text-[14px]" aria-label="Your signatures">
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Used for</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {set.signatures.map((s) => {
                    const uses = [
                      ...(set.defaults.newMessage === s.id ? ["New messages"] : []),
                      ...(set.defaults.reply === s.id ? ["Replies"] : []),
                    ];
                    return (
                      <tr key={s.id}>
                        <td className="max-w-0 py-2 pl-4">
                          <span className="block truncate">{s.name}</span>
                        </td>
                        <td className="hidden py-2 sm:table-cell">
                          <span className="am-micro">{uses.join(" · ")}</span>
                        </td>
                        <td className="w-px py-1.5 pr-2">
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              type="button"
                              aria-label={`Edit ${s.name}`}
                              disabled={busy}
                              onClick={() => {
                                setStatus(null);
                                setEditing(s);
                              }}
                              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                            >
                              <Pencil className="size-4" aria-hidden />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${s.name}`}
                              disabled={busy}
                              onClick={() => {
                                setStatus(null);
                                setDeleting(s);
                              }}
                              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </button>
                            <Menu
                              label={`More options for ${s.name}`}
                              icon={Ellipsis}
                              items={[
                                {
                                  label: "Duplicate",
                                  icon: Copy,
                                  disabled: busy || full,
                                  onSelect: () => {
                                    duplicate(s);
                                  },
                                },
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex flex-col divide-y rounded-xl border">
            <DefaultPicker
              label="Default for new messages"
              value={set.defaults.newMessage ?? ""}
              options={options}
              disabled={busy}
              onChange={(v) => {
                setDefault("newMessage", v);
              }}
            />
            <DefaultPicker
              label="Default for replies and forwards"
              value={set.defaults.reply ?? ""}
              options={options}
              disabled={busy}
              onChange={(v) => {
                setDefault("reply", v);
              }}
            />
          </div>
        </>
      )}
      <span
        aria-live="polite"
        className={`am-small min-h-5 ${status?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {status?.text ?? ""}
      </span>

      {editing !== null && set !== null && (
        <SignatureDialog
          signature={editing === "new" ? null : editing}
          taken={set.signatures.filter((s) => editing === "new" || s.id !== editing.id).map((s) => s.name)}
          onClose={() => {
            setEditing(null);
          }}
          onSave={async (input) => {
            const r =
              editing === "new"
                ? await client.createSignature(accountId, input)
                : await client.updateSignature(accountId, editing.id, input);
            apply(r, editing === "new" ? `Added “${input.name}”.` : `Saved “${input.name}”.`);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete signature?"
          body={`“${deleting.name}” is deleted from this mailbox. Messages you already sent keep it.`}
          confirm="Delete signature"
          onConfirm={() => {
            const target = deleting;
            void run(() => client.deleteSignature(accountId, target.id), `Deleted “${target.name}”.`);
          }}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

function DefaultPicker({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="h-9 w-full max-w-64 rounded-lg border bg-background px-2.5 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:w-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * "Add signature" / "Edit signature": a name and the composer's rich editor and toolbar, with images embedded from
 * files (never links to other servers). What will be kept is checked here with the same sanitiser the server runs.
 */
export function SignatureDialog({
  signature,
  taken,
  onSave,
  onClose,
}: {
  signature: SignatureView | null;
  /** The other signatures' names (names are unique per mailbox, ignoring case). */
  taken: string[];
  onSave: (input: { name: string; html: string }) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const outgoing = useOutgoing();
  const editor = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(signature?.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sanitize = useMemo(() => ({ embeddedImagesOnly: true, maxDataImage: SIGNATURE_IMAGE_URI_MAX }), []);
  const initialHtml = useMemo(
    () => (outgoing ? outgoing.sanitizeOutgoingHtml(signature?.html ?? "", sanitize).html : null),
    [outgoing, signature, sanitize],
  );

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    const n = signatureName(name);
    if (n === null) {
      setNameError(`Give the signature a name of up to ${String(WEBMAIL_SIGNATURES.nameChars)} characters.`);
      return;
    }
    if (taken.some((t) => sameSignatureName(t, n))) {
      setNameError("You already have a signature with that name.");
      return;
    }
    const mod = await loadSignatureModule();
    const clean = mod.cleanSignature(editor.current?.innerHTML ?? "");
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
    <Modal title={signature ? "Edit signature" : "Add signature"} onClose={onClose} size="lg">
      <form onSubmit={(e) => void save(e)} className="flex max-h-[min(40rem,calc(100dvh-8rem))] flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Name</span>
          <input
            autoFocus
            value={name}
            maxLength={WEBMAIL_SIGNATURES.nameChars}
            required
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            placeholder="Work"
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
            label="Signature"
            placeholder="Your name, role, phone, links"
            sanitize={sanitize}
            embedImages={{ onError: setError }}
            className="min-h-40 flex-1"
          />
        </div>
        <p className="am-micro">
          Images are embedded in the signature (PNG, JPEG, GIF or WebP, up to {String(WEBMAIL_SIGNATURES.imageKb)} KB
          each and {String(WEBMAIL_SIGNATURES.imagesPerSignature)} per signature). Links to images on other websites are
          removed, so nothing loads from elsewhere when your mail is read.
        </p>
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

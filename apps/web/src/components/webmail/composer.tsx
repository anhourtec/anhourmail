// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Ellipsis,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  PenLine,
  Send,
  Signature,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { WEBMAIL_ATTACHMENTS } from "@anhourmail/shared";
import { defaultSignature, SIGNATURE_IMAGE_URI_MAX, type SignatureSet } from "@anhourmail/shared/signatures";

import type { Address } from "@/server/webmail/view";
import { Tooltip } from "@/components/tooltip";

import { displayName, fileSize } from "./format";
import { ConfirmDialog } from "./dialogs";
import { Menu } from "./menu";
import { parkRemoteImages, unparkRemoteImages } from "./remote-images";
import { loadOutgoing, type Outgoing, RichEditor, useOutgoing } from "./rich-editor";
import { hasFormatting, SIGNATURE_ATTR, signatureHtml, signatureInner, textToHtml } from "./rich-text";
import {
  type Attachment,
  type DelegatedSender,
  type DraftPayload,
  type Identity,
  type MailClient,
  RefusedError,
  SignedOutError,
} from "./mail-client";

/** What a composer starts with (new, reply, reply all, forward, or an existing draft). */
export type ComposeSeed = {
  title: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  inReplyTo?: string[];
  references?: string[];
  attachments: Attachment[];
  /** An existing draft being edited (it is replaced on save). */
  draftId?: string;
  /** Preferred sender (e.g. the address a reply was sent to). */
  fromEmail?: string;
  /**
   * Start with From set to this mailbox shared with the person (written in a shared mailbox's own view): sent as it, or
   * on its behalf, when it is among `senders`. The person can still choose another From.
   */
  fromMailbox?: string;
  /**
   * Attachments of a message in a mailbox shared with the person (a forward written there): each is fetched from that
   * mailbox (`url`, read with its access) and uploaded to the person's own draft like a file they add, so neither
   * mailbox's access ever reaches the other's files.
   */
  copyAttachments?: { name: string; type: string; size: number; url: string }[];
  /** Where the caret starts: the top of the body (replies) or the To field. */
  focus: "to" | "body";
  /**
   * Start with the default signature for this kind of message: "new", or "reply" (replies and forwards). Absent when
   * reopening a draft (it has its signature already); the signature can still be switched.
   */
  signature?: SignatureKind;
  /** The body as HTML for rich text (a quoted original, or a draft's HTML); sanitised before the editor shows it. */
  html?: string;
  /** Rich text (the default) or plain text (e.g. reopening a plain-text draft). */
  mode?: ComposeFormat;
};

export type ComposeFormat = "rich" | "plain";
export type SignatureKind = "new" | "reply";

/** How signatures are sanitised before the composer inserts one (they were sanitised on save too). */
const SIGNATURE_SANITIZE = { embeddedImagesOnly: true, maxDataImage: SIGNATURE_IMAGE_URI_MAX } as const;

/** The block a signature adds to a plain-text message: the conventional "-- " separator line, then the text. */
export const signatureBlock = (signature: string | undefined): string =>
  signature && signature.trim() !== "" ? `\n\n-- \n${signature}` : "";

/** The body a composer starts with: the signature above any quoted text (so the reply is written above both). */
export function initialBody(seed: ComposeSeed, signature: string | undefined): string {
  return seed.signature ? `${signatureBlock(signature)}${seed.text}` : seed.text;
}

/**
 * Replaces the signature of a plain-text message with `to` (removes it for none). The signature is what follows the
 * last "-- " line of the part you wrote, which ends where the quoted message (`quoted`, the text a reply or forward
 * started with) begins, so the quoted message (which may have a "-- " line of its own) is never touched. Without a
 * signature yet, the new one goes at the end of what you wrote.
 */
export function swapSignature(text: string, to: string | undefined, quoted = ""): string {
  let split = text.length;
  if (quoted.trim() !== "") {
    if (text.endsWith(quoted)) split = text.length - quoted.length;
    else {
      const first = quoted.trim().split("\n")[0] ?? "";
      const at = first === "" ? -1 : text.indexOf(first);
      if (at >= 0) split = at;
    }
  }
  const mine = text.slice(0, split);
  let rest = text.slice(split);
  if (rest !== "" && !rest.startsWith("\n")) rest = `\n\n${rest}`;
  const sep = mine.startsWith("-- \n") ? 0 : mine.lastIndexOf("\n-- \n");
  const head = (sep >= 0 ? mine.slice(0, sep) : mine).replace(/\s+$/u, "");
  return `${head}${signatureBlock(to)}${rest}`;
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const MAX_UPLOAD = WEBMAIL_ATTACHMENTS.perFileMb * 1024 * 1024;
const AUTOSAVE_MS = 2000;

/** Splits pasted or typed text ("Sam <s@x.test>, jo@x.test") into addresses. */
function parseAddresses(input: string): { valid: Address[]; rest: string } {
  const valid: Address[] = [];
  const bad: string[] = [];
  for (const part of input.split(/[,;\n]+/)) {
    const p = part.trim();
    if (p === "") continue;
    const m = /^(.*)<([^<>]+)>$/.exec(p);
    const email = (m?.[2] ?? p).trim();
    const name = m?.[1]?.trim().replace(/^"|"$/g, "") ?? null;
    if (EMAIL.test(email)) valid.push({ name: name === "" ? null : name, email: email.toLowerCase() });
    else bad.push(p);
  }
  return { valid, rest: bad.join(", ") };
}

function AddressField({
  label,
  value,
  onChange,
  contacts,
  autoFocus,
  knownAddresses,
  onAddContact,
}: {
  label: string;
  value: Address[];
  onChange: (next: Address[]) => void;
  contacts: Address[];
  autoFocus?: boolean;
  knownAddresses: ReadonlySet<string>;
  onAddContact: (person: Address) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (q.length < 1) return [];
    const taken = new Set(value.map((a) => a.email));
    return contacts
      .filter((c) => !taken.has(c.email.toLowerCase()))
      .filter((c) => c.email.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [text, contacts, value]);

  const commit = (raw: string) => {
    const { valid, rest } = parseAddresses(raw);
    if (valid.length > 0) {
      const seen = new Set(value.map((a) => a.email));
      onChange([...value, ...valid.filter((a) => !seen.has(a.email))]);
    }
    setText(rest);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && suggestions[active] && text.trim() !== "") {
      e.preventDefault();
      const s = suggestions[active];
      onChange([...value, { name: s.name, email: s.email.toLowerCase() }]);
      setText("");
      setActive(0);
    } else if (e.key === "Enter" || e.key === "," || e.key === ";") {
      if (text.trim() !== "") {
        e.preventDefault();
        commit(text);
      }
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="relative flex min-h-10 items-start gap-2 border-b px-4 py-1.5">
      <label htmlFor={id} className="w-10 shrink-0 pt-1.5 text-[13px] text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((a) => (
          <span
            key={a.email}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent py-0.5 pr-1 pl-2 text-[12.5px]"
          >
            <span className="truncate">{a.name ? `${a.name} ` : ""}</span>
            <span className={`truncate font-mono ${a.name ? "text-muted-foreground" : ""}`}>{a.email}</span>
            {!knownAddresses.has(a.email.toLowerCase()) && (
              <button
                type="button"
                aria-label={`Add ${a.email} to contacts`}
                onClick={() => {
                  onAddContact(a);
                }}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-primary"
              >
                <UserPlus className="size-3" aria-hidden />
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove ${a.email}`}
              onClick={() => {
                onChange(value.filter((x) => x.email !== a.email));
              }}
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={focused && suggestions.length > 0}
          aria-controls={`${id}-list`}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]/.test(v)) commit(v);
            else setText(v);
            setActive(0);
          }}
          onKeyDown={onKey}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
            if (text.trim() !== "") commit(text);
          }}
          className="h-7 min-w-32 flex-1 bg-transparent font-mono text-[13px] outline-none"
        />
      </div>
      {focused && suggestions.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label="Suggestions"
          className="absolute top-full right-4 left-16 z-10 mt-1 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.email}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange([...value, { name: s.name, email: s.email.toLowerCase() }]);
                setText("");
              }}
              className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] ${i === active ? "bg-accent" : ""}`}
            >
              <span className="truncate">{displayName(s)}</span>
              <span className="truncate font-mono text-[12px] text-muted-foreground">{s.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

/** From-picker values for a mailbox shared with the person (identity ids never contain ":"). */
const SHARED_FROM = "shared:";

/**
 * Writing mail: To/Cc/Bcc with suggestions, From (own identities only — the BFF re-checks), subject, a rich-text
 * body (plain text is a mode in "More options"), attachments (uploaded through the BFF, 20 MB each). Drafts autosave
 * two seconds after you stop typing (one draft per message, replaced each time). Send saves the draft and hands it to
 * the BFF, which holds it for a few seconds so "Undo" can cancel it.
 *
 * Variants: a floating panel on wide screens (expandable), full screen on phones, and inline under a message.
 */
export function Composer({
  client,
  identities,
  senders = [],
  signatures,
  contacts,
  knownAddresses,
  onAddContact,
  seed,
  variant,
  trashId,
  onClose,
  onSent,
  onSavedDraft,
  alwaysCcBcc = false,
}: {
  client: MailClient;
  identities: Identity[];
  /**
   * Mailboxes shared with the person they may send from (ADR-0026 §6): offered in From after their own addresses, as
   * the mailbox (send as) or "<them> on behalf of <mailbox>". The draft stays in their own mailbox; the server sends it
   * from the chosen one.
   */
  senders?: DelegatedSender[];
  /** The mailbox's signatures and defaults; null while they load. */
  signatures: SignatureSet | null;
  contacts: Address[];
  /** Addresses already in an address book (lowercase); other chips offer "Add to contacts". */
  knownAddresses: ReadonlySet<string>;
  onAddContact: (person: Address) => void;
  seed: ComposeSeed;
  variant: "panel" | "inline";
  /** Where a discarded draft goes. */
  trashId: string | undefined;
  onClose: (opts: { savedDraft: boolean }) => void;
  /** `from`: the shared mailbox it went from (undo names it), absent for the person's own. */
  onSent: (submissionId: string, draftId: string, holdSeconds: number, from?: string) => void;
  onSavedDraft?: () => void;
  /** Show the Cc and Bcc fields from the start (a setting). */
  alwaysCcBcc?: boolean;
}) {
  const [to, setTo] = useState(seed.to);
  const [cc, setCc] = useState(seed.cc);
  const [bcc, setBcc] = useState(seed.bcc);
  const [showCc, setShowCc] = useState(alwaysCcBcc || seed.cc.length > 0 || seed.bcc.length > 0);
  const [subject, setSubject] = useState(seed.subject);
  const [identityId, setIdentityId] = useState(
    () => identities.find((i) => i.email === seed.fromEmail)?.id ?? identities[0]?.id ?? "",
  );
  /** A mailbox shared with the person chosen in From (sent as or on its behalf), or null for an own address. */
  const [sharedFrom, setSharedFrom] = useState<string | null>(() => {
    const preset = seed.fromMailbox?.toLowerCase();
    return preset !== undefined && senders.some((m) => m.mailbox === preset) ? preset : null;
  });
  const kind = seed.signature;
  const [format, setFormat] = useState<ComposeFormat>(seed.mode ?? "rich");
  /** The chosen signature's id; null for none; undefined until the signatures have loaded (new messages and replies). */
  const [sigChoice, setSigChoice] = useState<string | null | undefined>(() =>
    kind === undefined ? null : signatures ? (defaultSignature(signatures, kind)?.id ?? null) : undefined,
  );
  const chosen = signatures?.signatures.find((x) => x.id === sigChoice) ?? null;
  const [text, setText] = useState(() => initialBody(seed, chosen?.text));
  const [attachments, setAttachments] = useState<Attachment[]>(seed.attachments);
  const [uploading, setUploading] = useState(0);
  // Identities can arrive after the composer opened: pick the sender then.
  const [seenIdentities, setSeenIdentities] = useState(identities);
  if (seenIdentities !== identities) {
    setSeenIdentities(identities);
    const pick = identities.find((i) => i.email === seed.fromEmail) ?? identities[0];
    if (identityId === "" && pick) setIdentityId(pick.id);
  }
  // Signatures can arrive after the composer opened too: the default for this kind of message goes in then.
  const [seenSignatures, setSeenSignatures] = useState(signatures);
  if (seenSignatures !== signatures) {
    setSeenSignatures(signatures);
    if (kind !== undefined && sigChoice === undefined && signatures) {
      const d = defaultSignature(signatures, kind);
      setSigChoice(d?.id ?? null);
      if (format === "plain" && d) setText((t) => swapSignature(t, d.text, seed.text));
    }
  }
  /** Switches the message's signature (or removes it); only the signature block changes. */
  const chooseSignature = (id: string | null) => {
    const next = signatures?.signatures.find((x) => x.id === id) ?? null;
    // A reopened draft's text is all its own: only a new message's or a reply's seed text is the quoted part.
    if (format === "plain") setText((t) => swapSignature(t, next?.text, kind === undefined ? "" : seed.text));
    setSigChoice(next?.id ?? null);
  };
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const draftId = useRef<string | undefined>(seed.draftId);
  const dirty = useRef(false);
  const discarded = useRef(false);
  const saving = useRef<Promise<string | undefined> | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  // Rich text: the editor's DOM is the working copy; `richVersion` counts edits (for autosave). Every save sends it
  // through the outgoing sanitiser, and the server sanitises it again.
  const outgoing = useOutgoing();
  const editor = useRef<HTMLDivElement>(null);
  const [richSource, setRichSource] = useState(() => ({
    body: seed.html ?? textToHtml(seed.text),
    signature: seed.signature !== undefined,
    key: 0,
  }));
  const [richVersion, setRichVersion] = useState(0);
  // Remote images are shown as placeholders while writing (nothing loads); they are put back for saving.
  const initialHtml = useMemo(
    () => (outgoing ? parkRemoteImages(outgoing.sanitizeOutgoingHtml(richSource.body).html) : null),
    [outgoing, richSource.body],
  );
  /** The editor's HTML as it will be sent (remote images put back), before sanitising. */
  const editorHtml = () => unparkRemoteImages(editor.current?.innerHTML ?? "");
  /** Asking before rich text becomes plain text (its formatting is dropped). */
  const [confirmPlain, setConfirmPlain] = useState(false);
  /** The signature HTML the editor holds; null until the editor has been filled. */
  const appliedSig = useRef<string | null>(null);
  const richReady = format === "rich" && initialHtml !== null;
  /** The chosen signature as it goes into the editor (sanitised again; "" for none). */
  const sigHtml = useMemo(
    () => (chosen && outgoing ? outgoing.sanitizeOutgoingHtml(chosen.html, SIGNATURE_SANITIZE).html : ""),
    [chosen, outgoing],
  );
  useEffect(() => {
    const el = editor.current;
    if (!richReady || !el) return;
    if (appliedSig.current === null) {
      // First fill: the signature goes above the quoted text, as in plain text.
      if (richSource.signature && sigHtml !== "") el.insertAdjacentHTML("afterbegin", signatureHtml(sigHtml));
      appliedSig.current = sigHtml;
      return;
    }
    if (appliedSig.current === sigHtml) return;
    // Only the marked block changes (it stays, empty, for "no signature", so another can take its place).
    const block = el.querySelector(`[${SIGNATURE_ATTR}]`);
    if (block) block.innerHTML = signatureInner(sigHtml);
    else if (sigHtml !== "") {
      // No block (e.g. after plain text mode): new messages get it at the end, replies above the quoted message.
      el.insertAdjacentHTML(kind === "reply" ? "afterbegin" : "beforeend", signatureHtml(sigHtml));
    }
    appliedSig.current = sigHtml;
    setRichVersion((v) => v + 1);
  }, [richReady, sigHtml, kind, richSource]);

  const switchFormat = (next: ComposeFormat, confirmed = false) => {
    if (next === format) return;
    if (next === "plain" && !confirmed && outgoing && hasFormatting(outgoing.sanitizeOutgoingHtml(editorHtml()).html)) {
      // Nothing changes until the person agrees; Cancel leaves the rich text as it is.
      setConfirmPlain(true);
      return;
    }
    if (next === "plain") {
      const raw = editorHtml();
      setText(
        outgoing ? outgoing.outgoingText(outgoing.sanitizeOutgoingHtml(raw).html) : (editor.current?.textContent ?? ""),
      );
    } else {
      // The signature is already in the text: the editor starts from it as is.
      appliedSig.current = sigHtml;
      setRichSource((r) => ({ body: textToHtml(text), signature: false, key: r.key + 1 }));
    }
    setFormat(next);
  };

  useEffect(() => {
    if (seed.focus === "body") {
      body.current?.focus();
      body.current?.setSelectionRange(0, 0);
    }
  }, [seed.focus]);

  /** The draft to save; null when the rich body is over the HTML cap. */
  const payload = useCallback(
    (mod: Outgoing): DraftPayload | null => {
      let content: { text: string; html?: string } = { text };
      if (format === "rich") {
        const clean = mod.sanitizeOutgoingHtml(editorHtml());
        if (clean.tooLarge) return null;
        // The server writes the text/plain part from the HTML.
        content = { text: "", html: clean.html };
      }
      return {
        ...(draftId.current ? { replaces: draftId.current } : {}),
        identityId,
        to,
        cc,
        bcc,
        subject,
        ...content,
        ...(seed.inReplyTo?.length ? { inReplyTo: seed.inReplyTo } : {}),
        ...(seed.references?.length ? { references: seed.references } : {}),
        attachments,
      };
    },
    [format, identityId, to, cc, bcc, subject, text, attachments, seed.inReplyTo, seed.references],
  );

  /** Saves now (waiting for any save in flight first, so drafts are replaced in order). */
  const saveNow = useCallback(async (): Promise<string | undefined> => {
    if (saving.current) await saving.current.catch(() => undefined);
    if (discarded.current) return undefined;
    const run = (async () => {
      setSave("saving");
      try {
        const draft = payload(await loadOutgoing());
        if (!draft) {
          setSave("error");
          setError("This message is too long to save. Shorten it or remove some images.");
          return undefined;
        }
        const { id } = await client.saveDraft(draft);
        draftId.current = id;
        dirty.current = false;
        setSave("saved");
        onSavedDraft?.();
        return id;
      } catch (err) {
        setSave("error");
        if (err instanceof SignedOutError) throw err;
        setError(err instanceof RefusedError ? err.message : "The draft couldn't be saved.");
        return undefined;
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      if (saving.current === run) saving.current = null;
    }
  }, [client, payload, onSavedDraft]);

  // Autosave: two seconds after the last change (not on a timer).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dirty.current = true;
    setSave("idle");
    const t = window.setTimeout(() => {
      void saveNow().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [to, cc, bcc, subject, text, richVersion, format, attachments, identityId, saveNow]);

  const bodyHasContent = () =>
    format === "rich"
      ? (editor.current?.textContent ?? "").trim() !== "" || editor.current?.querySelector("img") != null
      : text.trim() !== "";
  const hasContent = () =>
    to.length + cc.length + bcc.length > 0 || subject.trim() !== "" || bodyHasContent() || attachments.length > 0;

  const close = async () => {
    const saved =
      dirty.current && hasContent()
        ? (await saveNow().catch(() => undefined)) !== undefined
        : draftId.current !== undefined && hasContent();
    onClose({ savedDraft: saved });
  };

  const discard = async () => {
    // Stop autosave from writing a new copy, let any save in flight land, then move the draft to Trash
    // (the proxy only deletes forever from Trash or Junk).
    discarded.current = true;
    if (saving.current) await saving.current.catch(() => undefined);
    const id = draftId.current;
    onClose({ savedDraft: false });
    if (id && trashId) {
      try {
        await client.restore({ [id]: { [trashId]: true } });
        onSavedDraft?.();
      } catch {
        // The draft stays in Drafts; nothing is lost.
      }
    }
  };

  const send = async () => {
    setError(null);
    if (to.length + cc.length + bcc.length === 0) {
      setError("Add at least one recipient.");
      return;
    }
    if (uploading > 0) {
      setError("Wait for the attachments to finish uploading.");
      return;
    }
    if (!identityId) {
      setError("There's no address to send from.");
      return;
    }
    setSending(true);
    try {
      const id = dirty.current || !draftId.current ? await saveNow() : draftId.current;
      if (!id) return;
      const { submissionId, holdSeconds } = await client.send(id, identityId, sharedFrom ?? undefined);
      onSent(submissionId, id, holdSeconds, sharedFrom ?? undefined);
    } catch (err) {
      if (err instanceof SignedOutError) throw err;
      setError(err instanceof RefusedError ? err.message : "Couldn't send. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.size > MAX_UPLOAD) {
        setError(`${f.name} is larger than ${String(WEBMAIL_ATTACHMENTS.perFileMb)} MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const up = await client.upload(f);
        setAttachments((list) => [...list, { blobId: up.blobId, name: f.name, type: up.type, size: up.size }]);
      } catch (err) {
        setError(err instanceof RefusedError ? err.message : `${f.name} couldn't be uploaded.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // A forward written in a mailbox shared with the person: its attachments are copied into this draft once.
  const copied = useRef(false);
  useEffect(() => {
    const list = seed.copyAttachments;
    if (copied.current || !list || list.length === 0) return;
    copied.current = true;
    void (async () => {
      for (const a of list) {
        if (a.size > MAX_UPLOAD) {
          setError(`${a.name} is larger than ${String(WEBMAIL_ATTACHMENTS.perFileMb)} MB.`);
          continue;
        }
        setUploading((n) => n + 1);
        let file: File | null = null;
        try {
          const res = await fetch(a.url);
          if (res.ok) file = new File([await res.blob()], a.name, { type: a.type });
        } catch {
          // Reported below.
        } finally {
          setUploading((n) => n - 1);
        }
        if (file) await addFiles([file]);
        else setError(`${a.name} couldn't be attached. Download it and add it again.`);
      }
    })();
    // Once, when the composer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the seed's attachments are copied once
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      // An open menu (More options) closes itself; the composer stays.
      if (e.target instanceof Element && e.target.closest("[role=menu]")) return;
      e.preventDefault();
      e.stopPropagation();
      void close();
    }
  };

  const identity = identities.find((i) => i.id === identityId);
  const frame =
    variant === "inline"
      ? "flex max-h-[min(34rem,70dvh)] min-h-72 flex-col rounded-xl border bg-card shadow-sm"
      : expanded
        ? "fixed inset-0 z-50 flex flex-col bg-card md:inset-6 md:rounded-2xl md:border md:shadow-2xl"
        : "fixed inset-0 z-50 flex flex-col bg-card md:inset-auto md:right-6 md:bottom-6 md:h-[min(40rem,calc(100dvh-3rem))] md:w-[min(40rem,calc(100vw-3rem))] md:rounded-2xl md:border md:shadow-2xl";

  return (
    <section
      role="dialog"
      aria-modal={variant === "panel"}
      aria-label={seed.title}
      className={frame}
      onKeyDown={onKeyDown}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate font-medium text-[14px]">{seed.title}</h2>
        <span className="am-micro mr-2" aria-live="polite">
          {save === "saving" ? "Saving…" : save === "saved" ? "Draft saved" : save === "error" ? "Not saved" : ""}
        </span>
        {variant === "panel" && (
          <button
            type="button"
            onClick={() => {
              setExpanded((x) => !x);
            }}
            aria-label={expanded ? "Shrink" : "Expand"}
            className="hidden size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:inline-flex"
          >
            {expanded ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
          </button>
        )}
        <Tooltip label="Close and keep as draft" shortcut="Esc">
          <button
            type="button"
            onClick={() => {
              void close();
            }}
            aria-label="Close and keep as draft"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </header>

      {identities.length > 1 || (identities.length > 0 && senders.length > 0) ? (
        <div className="flex h-10 items-center gap-2 border-b px-4">
          <label htmlFor="compose-from" className="w-10 shrink-0 text-[13px] text-muted-foreground">
            From
          </label>
          <select
            id="compose-from"
            value={sharedFrom === null ? identityId : `${SHARED_FROM}${sharedFrom}`}
            onChange={(e) => {
              const v = e.target.value;
              setSharedFrom(v.startsWith(SHARED_FROM) ? v.slice(SHARED_FROM.length) : null);
              if (!v.startsWith(SHARED_FROM)) setIdentityId(v);
            }}
            className="h-8 min-w-0 flex-1 rounded-md bg-transparent font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {senders.length > 0 ? (
              <>
                <optgroup label="Your addresses">
                  {identities.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.email}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Shared with you">
                  {senders.map((m) => (
                    <option key={m.mailbox} value={`${SHARED_FROM}${m.mailbox}`}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.email}
                </option>
              ))
            )}
          </select>
        </div>
      ) : (
        identity && (
          <div className="flex h-10 items-center gap-2 border-b px-4">
            <span className="w-10 shrink-0 text-[13px] text-muted-foreground">From</span>
            <span className="truncate font-mono text-[13px]">{identity.email}</span>
          </div>
        )
      )}
      <div className="relative">
        <AddressField
          label="To"
          value={to}
          onChange={setTo}
          contacts={contacts}
          autoFocus={seed.focus === "to"}
          knownAddresses={knownAddresses}
          onAddContact={onAddContact}
        />
        {!showCc && (
          <button
            type="button"
            onClick={() => {
              setShowCc(true);
            }}
            className="absolute top-2 right-3 rounded-md px-2 py-0.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Cc Bcc
          </button>
        )}
      </div>
      {showCc && (
        <>
          <AddressField
            label="Cc"
            value={cc}
            onChange={setCc}
            contacts={contacts}
            knownAddresses={knownAddresses}
            onAddContact={onAddContact}
          />
          <AddressField
            label="Bcc"
            value={bcc}
            onChange={setBcc}
            contacts={contacts}
            knownAddresses={knownAddresses}
            onAddContact={onAddContact}
          />
        </>
      )}
      <div className="flex h-10 items-center gap-2 border-b px-4">
        <label htmlFor="compose-subject" className="sr-only">
          Subject
        </label>
        <input
          id="compose-subject"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
          }}
          placeholder="Subject"
          maxLength={998}
          className="h-8 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
        />
      </div>
      {format === "rich" ? (
        <RichEditor
          key={richSource.key}
          editorRef={editor}
          initialHtml={initialHtml}
          outgoing={outgoing}
          onChange={() => {
            setRichVersion((v) => v + 1);
          }}
          autoFocus={seed.focus === "body" || richSource.key > 0}
        />
      ) : (
        <>
          <label htmlFor="compose-body" className="sr-only">
            Message
          </label>
          <textarea
            id="compose-body"
            ref={body}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            placeholder="Write your message"
            className="min-h-32 flex-1 resize-none bg-transparent px-4 py-3 text-[14px] leading-6 outline-none"
          />
        </>
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2 border-t px-4 py-2.5">
          {attachments.map((a) => (
            <li
              key={a.blobId + a.name}
              className="inline-flex max-w-64 items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-2.5 text-[12.5px]"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{a.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fileSize(a.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => {
                  setAttachments((list) => list.filter((x) => x !== a));
                }}
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {uploading > 0 && (
            <li className="inline-flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Uploading…
            </li>
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="am-small border-t px-4 py-2 text-destructive">
          {error}
        </p>
      )}
      <footer className="flex shrink-0 items-center gap-1 border-t px-3 py-2.5">
        <button
          type="button"
          onClick={() => {
            void send();
          }}
          disabled={sending}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 font-medium text-[14px] text-primary-foreground transition-opacity disabled:opacity-60"
        >
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
          Send
        </button>
        <span className="am-micro ml-2 hidden lg:inline">⌘/Ctrl + Enter</span>
        <span className="flex-1" />
        <input
          ref={file}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Tooltip label={`Attach files (${String(WEBMAIL_ATTACHMENTS.perFileMb)} MB each)`}>
          <button
            type="button"
            onClick={() => file.current?.click()}
            aria-label="Attach files"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Paperclip className="size-4" aria-hidden />
          </button>
        </Tooltip>
        {signatures && (
          <Menu
            label="Signature"
            icon={Signature}
            side="top"
            className="[&_[aria-haspopup=menu]]:size-9"
            items={[
              { heading: "Signature" },
              {
                label: "(No signature)",
                checked: chosen === null,
                onSelect: () => {
                  chooseSignature(null);
                },
              },
              ...signatures.signatures.map((x) => ({
                label: x.name,
                checked: chosen?.id === x.id,
                onSelect: () => {
                  chooseSignature(x.id);
                },
              })),
              ...(signatures.signatures.length === 0
                ? [{ label: "Add signatures in Settings → Writing", disabled: true, onSelect: () => undefined }]
                : []),
            ]}
          />
        )}
        <Menu
          label="More options"
          icon={Ellipsis}
          side="top"
          className="[&_[aria-haspopup=menu]]:size-9"
          items={[
            format === "rich"
              ? {
                  label: "Plain text mode",
                  icon: FileText,
                  onSelect: () => {
                    switchFormat("plain");
                  },
                }
              : {
                  label: "Switch to rich text",
                  icon: PenLine,
                  onSelect: () => {
                    switchFormat("rich");
                  },
                },
          ]}
        />
        <Tooltip label="Discard draft">
          <button
            type="button"
            onClick={() => {
              void discard();
            }}
            aria-label="Discard draft"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </footer>
      {confirmPlain && (
        <ConfirmDialog
          title="Switch to plain text?"
          body="Switching to plain text removes formatting such as bold, links, lists and images. Your text is kept."
          confirm="Switch to plain text"
          onConfirm={() => {
            switchFormat("plain", true);
          }}
          onClose={() => {
            setConfirmPlain(false);
          }}
        />
      )}
    </section>
  );
}

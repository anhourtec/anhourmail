// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Bold,
  CodeXml,
  Italic,
  Link,
  List,
  ListOrdered,
  RemoveFormatting,
  TextQuote,
  TriangleAlert,
  Underline,
  Upload,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type * as OutgoingModule from "@/server/webmail/outgoing-html";
import { Tooltip } from "@/components/tooltip";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

import { Modal } from "./dialogs";
import { frameDocument } from "./message-frame";
import { parkRemoteImages } from "./remote-images";
import { escapeHtml, linkUrl, removedSummary } from "./rich-text";

/**
 * The rich-text editor (docs/internal/05-webmail.md "Compose"): a contentEditable area, a small formatting toolbar,
 * a link form and "Insert HTML". Whatever it holds is only a working copy: every paste, drop and inserted HTML goes
 * through the outgoing sanitiser before it reaches the editor, and the composer sanitises the whole body again
 * before saving (the server does a third pass). The page's CSP (no inline script, same-origin images only) backs
 * this up while the HTML sits in the editor.
 */

export type Outgoing = typeof OutgoingModule;

let loading: Promise<Outgoing> | null = null;
/** Loads the sanitiser once, on first use (it is only needed while writing mail). */
export const loadOutgoing = (): Promise<Outgoing> => (loading ??= import("@/server/webmail/outgoing-html"));

/** The sanitiser module, once loaded. */
export function useOutgoing(): Outgoing | null {
  const [mod, setMod] = useState<Outgoing | null>(null);
  useEffect(() => {
    let live = true;
    void loadOutgoing().then((m) => {
      if (live) setMod(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return mod;
}

/** Runs an editing command on the focused editor. */
function exec(command: string, value?: string): void {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- contentEditable has no standard replacement; this keeps the undo stack
  document.execCommand(command, false, value);
}

/** The selection, if it is inside `root`. */
function rangeIn(root: HTMLElement | null): Range | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

/** Focuses `root` and puts back a saved selection (or the caret at the start). */
function restore(root: HTMLElement, range: Range | null): void {
  root.focus();
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  if (range) {
    sel.addRange(range);
  } else {
    const start = document.createRange();
    start.setStart(root, 0);
    start.collapse(true);
    sel.addRange(start);
  }
}

const toolButton =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";

/** A toolbar button that keeps the editor's selection: it never takes focus on mouse down. */
function ToolButton({
  label,
  icon,
  onRun,
  shortcut,
}: {
  label: string;
  icon: ReactNode;
  onRun: () => void;
  shortcut?: string;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={onRun}
        className={toolButton}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/**
 * The editing surface. `initialHtml` is set once it is available (already sanitised by the composer); after that the
 * DOM is the source of truth and every change is reported through `onChange`.
 */
export function RichEditor({
  editorRef,
  initialHtml,
  outgoing,
  onChange,
  autoFocus,
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  initialHtml: string | null;
  outgoing: Outgoing | null;
  /** The content changed (read it from `editorRef`). */
  onChange: () => void;
  autoFocus: boolean;
}) {
  const linkId = useId();
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const savedRange = useRef<Range | null>(null);
  const [inserting, setInserting] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    const el = editorRef.current;
    if (!el || initialHtml === null || initialised.current) return;
    initialised.current = true;
    el.innerHTML = initialHtml;
    exec("styleWithCSS", "false");
    if (autoFocus) restore(el, null);
  }, [editorRef, initialHtml, autoFocus]);

  const changed = () => {
    onChange();
  };

  const command = (name: string, value?: string) => {
    editorRef.current?.focus();
    exec(name, value);
    changed();
  };

  /** Inserts HTML from outside (paste, drop) after sanitising it; plain text when the sanitiser isn't loaded. */
  const insertForeign = (html: string, text: string) => {
    const clean = html !== "" && outgoing ? outgoing.sanitizeOutgoingHtml(html) : null;
    // Remote images show as placeholders while writing (nothing loads); the composer puts them back for saving.
    if (clean && !clean.tooLarge && clean.html !== "") exec("insertHTML", parkRemoteImages(clean.html));
    else if (text !== "") exec("insertText", text);
    changed();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    insertForeign(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.dataTransfer.getData("text/html");
    const text = e.dataTransfer.getData("text/plain");
    if (html === "" && text === "") return;
    // Where it was dropped (not every browser can tell; then it goes at the caret).
    const pos = "caretPositionFromPoint" in document ? document.caretPositionFromPoint(e.clientX, e.clientY) : null;
    let at: Range | null = null;
    if (pos && editorRef.current?.contains(pos.offsetNode)) {
      at = document.createRange();
      at.setStart(pos.offsetNode, pos.offset);
      at.collapse(true);
    }
    if (editorRef.current) restore(editorRef.current, at);
    insertForeign(html, text);
  };

  const openLink = () => {
    savedRange.current = rangeIn(editorRef.current);
    setLink("");
    setLinkError(null);
    setLinkOpen(true);
  };

  const addLink = () => {
    const url = linkUrl(link);
    if (!url) {
      setLinkError("Enter a web address (https://…), an email address or a tel: number.");
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    restore(el, savedRange.current);
    if (savedRange.current && !savedRange.current.collapsed) exec("createLink", url);
    else exec("insertHTML", `<a href="${escapeHtml(url)}">${escapeHtml(url.replace(/^mailto:|^tel:/, ""))}</a>`);
    setLinkOpen(false);
    changed();
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 py-1"
      >
        <ToolButton
          label="Bold"
          icon={<Bold className="size-4" aria-hidden />}
          onRun={() => {
            command("bold");
          }}
          shortcut="⌘/Ctrl + B"
        />
        <ToolButton
          label="Italic"
          icon={<Italic className="size-4" aria-hidden />}
          onRun={() => {
            command("italic");
          }}
          shortcut="⌘/Ctrl + I"
        />
        <ToolButton
          label="Underline"
          icon={<Underline className="size-4" aria-hidden />}
          onRun={() => {
            command("underline");
          }}
          shortcut="⌘/Ctrl + U"
        />
        <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
        <ToolButton label="Link" icon={<Link className="size-4" aria-hidden />} onRun={openLink} />
        <ToolButton
          label="Bulleted list"
          icon={<List className="size-4" aria-hidden />}
          onRun={() => {
            command("insertUnorderedList");
          }}
        />
        <ToolButton
          label="Numbered list"
          icon={<ListOrdered className="size-4" aria-hidden />}
          onRun={() => {
            command("insertOrderedList");
          }}
        />
        <ToolButton
          label="Quote"
          icon={<TextQuote className="size-4" aria-hidden />}
          onRun={() => {
            command("formatBlock", "blockquote");
          }}
        />
        <ToolButton
          label="Clear formatting"
          icon={<RemoveFormatting className="size-4" aria-hidden />}
          onRun={() => {
            command("removeFormat");
            command("unlink");
          }}
        />
        <span className="flex-1" />
        {outgoing && (
          <ToolButton
            label="Insert HTML"
            icon={<CodeXml className="size-4" aria-hidden />}
            onRun={() => {
              savedRange.current = rangeIn(editorRef.current);
              setInserting(true);
            }}
          />
        )}
      </div>
      {linkOpen && (
        <form
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            addLink();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setLinkOpen(false);
              if (editorRef.current) restore(editorRef.current, savedRange.current);
            }
          }}
        >
          <label htmlFor={linkId} className="sr-only">
            Link address
          </label>
          <input
            id={linkId}
            autoFocus
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(null);
            }}
            placeholder="https://example.com"
            inputMode="url"
            spellCheck={false}
            aria-invalid={linkError !== null}
            aria-describedby={linkError ? `${linkId}-error` : undefined}
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="inline-flex h-8 items-center rounded-md border px-3 text-[13px] hover:bg-accent"
          >
            Add link
          </button>
          <button
            type="button"
            aria-label="Cancel link"
            onClick={() => {
              setLinkOpen(false);
            }}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
          {linkError && (
            <p id={`${linkId}-error`} role="alert" className="am-small w-full text-destructive">
              {linkError}
            </p>
          )}
        </form>
      )}
      <div
        ref={editorRef}
        id="compose-body"
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        contentEditable={initialHtml !== null}
        suppressContentEditableWarning
        spellCheck
        onInput={changed}
        onPaste={onPaste}
        onDrop={onDrop}
        data-placeholder="Write your message"
        className="am-rich min-h-32 flex-1 overflow-y-auto px-4 py-3 text-[14px] leading-6 outline-none"
      />
      {inserting && outgoing && (
        <InsertHtmlDialog
          outgoing={outgoing}
          onClose={() => {
            setInserting(false);
          }}
          onInsert={(html) => {
            setInserting(false);
            if (!editorRef.current) return;
            restore(editorRef.current, savedRange.current);
            exec("insertHTML", parkRemoteImages(html));
            changed();
          }}
        />
      )}
    </>
  );
}

/**
 * "Insert HTML": paste source or upload an .html file (up to the sanitiser's cap), see it sanitised in the same
 * sandboxed frame the reader uses (no scripts, nothing remote loads), with what was removed and a warning about
 * remote images, then insert it where the caret was.
 */
export function InsertHtmlDialog({
  outgoing,
  onInsert,
  onClose,
}: {
  outgoing: Outgoing;
  onInsert: (html: string) => void;
  onClose: () => void;
}) {
  const sourceId = useId();
  const file = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const result = useMemo(() => outgoing.sanitizeOutgoingHtml(source), [outgoing, source]);
  const removed = useMemo(() => removedSummary(result), [result]);
  const maxMb = outgoing.MAX_OUTGOING_HTML / (1024 * 1024);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > outgoing.MAX_OUTGOING_HTML) {
      setError(`${f.name} is larger than ${String(maxMb)} MB.`);
      return;
    }
    setError(null);
    setSource(await f.text());
  };

  const empty = source.trim() === "";
  return (
    <Modal title="Insert HTML" onClose={onClose} size="lg">
      <div className="flex max-h-[min(40rem,calc(100dvh-8rem))] flex-col gap-3 overflow-y-auto">
        <p className="am-small text-muted-foreground">
          Paste HTML or upload an .html file. Scripts, forms, embedded frames and anything unsafe are removed before it
          goes into your message.
        </p>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={sourceId} className="text-[13px] font-medium">
            HTML source
          </label>
          <input
            ref={file}
            type="file"
            accept=".html,.htm,text/html"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => file.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] hover:bg-accent"
          >
            <Upload className="size-3.5" aria-hidden /> Upload .html
          </button>
        </div>
        <textarea
          id={sourceId}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setError(null);
          }}
          spellCheck={false}
          placeholder="<p>Hello</p>"
          className={`${inputClass} h-28 resize-y py-2 font-mono text-[12.5px]`}
        />
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        {result.tooLarge && (
          <p role="alert" className="am-small text-destructive">
            This HTML is larger than {String(maxMb)} MB.
          </p>
        )}
        {!empty && !result.tooLarge && (
          <>
            <div>
              <p className="mb-1.5 text-[13px] font-medium">Preview</p>
              <iframe
                title="Preview of the HTML to insert"
                sandbox=""
                srcDoc={frameDocument(parkRemoteImages(result.html))}
                referrerPolicy="no-referrer"
                className="block h-48 w-full rounded-lg border bg-background"
              />
            </div>
            {result.remoteImages > 0 && (
              <p className="am-small flex items-start gap-2 rounded-lg border border-l-4 border-l-[rgb(var(--am-status-warning))] px-3 py-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[rgb(var(--am-status-warning))]" aria-hidden />
                <span>
                  {result.remoteImages === 1 ? "1 image loads" : `${String(result.remoteImages)} images load`} from
                  another server when the message is read. Remote images can tell the sender when and where a message
                  was opened. They aren&apos;t shown in this preview.
                </span>
              </p>
            )}
            {removed.length > 0 && (
              <div className="am-small rounded-lg border px-3 py-2">
                <p className="font-medium">Removed</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {removed.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            disabled={empty || result.tooLarge || result.html === ""}
            onClick={() => {
              onInsert(result.html);
            }}
            className={primaryButtonClass}
          >
            Insert
          </button>
        </div>
      </div>
    </Modal>
  );
}

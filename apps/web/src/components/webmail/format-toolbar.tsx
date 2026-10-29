// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  ALargeSmall,
  Ban,
  Baseline,
  Bold,
  Check,
  ChevronDown,
  CodeXml,
  Highlighter,
  ImagePlus,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextQuote,
  Type,
  Underline,
  Undo2,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { menuKeys, PanelSurface, usePopover } from "@/components/popover";
import { Tooltip } from "@/components/tooltip";

import {
  ALIGNMENTS,
  type Alignment,
  alignmentOf,
  type Choice,
  colourHex,
  FONT_FAMILIES,
  FONT_SIZES,
  HIGHLIGHTS,
  matchFamily,
  matchSize,
  TEXT_COLOURS,
  writesCss,
} from "./format-options";

/**
 * The composer's formatting toolbar (docs/internal/05-webmail.md "Compose"): undo and redo, font, size, bold,
 * italic, underline, strikethrough, text colour, highlight, alignment, lists, indent, link, quote, clear formatting
 * and "Insert HTML". Every change is a browser editing command, so the editor's own undo history covers it. On a
 * narrow screen the row scrolls sideways; its menus open in a fixed layer outside the scrolling row, so they are
 * never clipped.
 */

/** Runs an editing command on the focused editor. */
export function exec(command: string, value?: string): void {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- contentEditable has no standard replacement; this keeps the undo stack
  document.execCommand(command, false, value);
}

/**
 * Runs a formatting command. Colour, font, size, alignment, strikethrough and indent write inline CSS (the values
 * the outgoing sanitiser keeps); everything else keeps its semantic tag (`<b>`, `<i>`, `<u>`, lists).
 */
export function format(command: string, value?: string): void {
  const css = writesCss(command);
  if (css) exec("styleWithCSS", "true");
  exec(command, value);
  if (css) exec("styleWithCSS", "false");
}

/** The selection, if it is inside `root`. */
export function rangeIn(root: HTMLElement | null): Range | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

/** Focuses `root` and puts back a saved selection (or the caret at the start). */
export function restore(root: HTMLElement, range: Range | null): void {
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

// eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the editing state the commands above write
const commandValue = (name: string): string => document.queryCommandValue(name);

const toolButton =
  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-lg px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-expanded:bg-accent aria-expanded:text-foreground";

/** A toolbar button that keeps the editor's selection: it never takes focus on mouse down. */
export function ToolButton({
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

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;

/** Space between the panel and the screen edge, and between the panel and its button (px). */
const EDGE = 8;
const GAP = 4;

/**
 * A toolbar button with a menu. The menu is drawn in `host` (a layer outside the scrolling toolbar) at a fixed
 * position under the button, kept on screen, and closes when the toolbar or page scrolls.
 */
function ToolMenu({
  label,
  icon,
  host,
  onOpen,
  children,
  grid = false,
}: {
  label: string;
  icon: ReactNode;
  host: HTMLElement | null;
  /** Called as the menu opens (save the selection, read the current state). */
  onOpen: () => void;
  /** The items; `done` closes the menu without moving focus back to the button. */
  children: (done: () => void) => ReactNode;
  /** Arrow keys move in a grid (colour swatches) rather than a column. */
  grid?: boolean;
}) {
  const { open, toggle, close, trigger, panel } = usePopover();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const r = trigger.current.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = r.bottom + GAP;
    const above = r.top - GAP - p.height;
    const top = below + p.height > vh - EDGE && above >= EDGE ? above : below;
    const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, vw - EDGE - p.width));
    setPos({ top, left });
  }, [open, trigger, panel]);

  const done = useCallback(() => {
    close(false);
    setPos(null);
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && panel.current?.contains(e.target))) done();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", done);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", done);
    };
  }, [open, done, panel]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Only this menu closes, not the composer around it.
      e.preventDefault();
      e.stopPropagation();
      close();
      setPos(null);
      return;
    }
    if (grid && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
      const i = items.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      items[(i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    menuKeys(e);
  };

  return (
    <>
      <Tooltip label={label} disabled={open}>
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            if (!open) onOpen();
            else setPos(null);
            toggle();
          }}
          className={toolButton}
        >
          {icon}
          <ChevronDown className="size-3 opacity-70" aria-hidden />
        </button>
      </Tooltip>
      {open &&
        host &&
        createPortal(
          <div
            ref={panel}
            className={`fixed z-50 ${pos ? "" : "pointer-events-none opacity-0"}`}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
          >
            <PanelSurface className="max-h-[min(24rem,calc(100dvh-6rem))] overflow-y-auto overscroll-contain">
              <div
                role="menu"
                aria-label={label}
                onKeyDown={onKeyDown}
                className={grid ? "grid grid-cols-6 gap-1 p-0.5" : "flex min-w-40 flex-col"}
              >
                {children(done)}
              </div>
            </PanelSurface>
          </div>,
          host,
        )}
    </>
  );
}

/** One choice in a list menu, with a check on the current one. */
function ChoiceItem({
  label,
  checked,
  onSelect,
  children,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked && <Check className="size-3.5" aria-hidden />}
      </span>
      {children ?? <span className="min-w-0 flex-1 truncate">{label}</span>}
    </button>
  );
}

/** A colour swatch. The fill is the message colour itself (content, not an interface colour). */
function Swatch({ colour, checked, onSelect }: { colour: Choice; checked: boolean; onSelect: () => void }) {
  const none = colour.value === "transparent";
  return (
    <Tooltip label={colour.label}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        aria-label={colour.label}
        onClick={onSelect}
        className={`inline-flex size-7 items-center justify-center rounded-md outline-none ring-offset-1 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring ${checked ? "ring-2 ring-foreground" : ""}`}
      >
        <span
          className="flex size-5 items-center justify-center rounded border border-border text-muted-foreground"
          style={none ? undefined : { backgroundColor: colour.value }}
        >
          {none && <Ban className="size-3.5" aria-hidden />}
        </span>
      </button>
    </Tooltip>
  );
}

const ALIGN_ICONS: Record<Alignment, ReactNode> = {
  left: <TextAlignStart className="size-4" aria-hidden />,
  center: <TextAlignCenter className="size-4" aria-hidden />,
  right: <TextAlignEnd className="size-4" aria-hidden />,
};

/** What the selection has now, read when a menu opens. */
type Current = { family?: string; size?: string; colour: string; highlight: string; align: Alignment };

export function FormatToolbar({
  editorRef,
  onChange,
  onLink,
  onInsertHtml,
  onInsertImage,
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  /** The content changed. */
  onChange: () => void;
  /** Opens the link form. */
  onLink: () => void;
  /** Opens "Insert HTML" (absent until the sanitiser has loaded). */
  onInsertHtml?: (() => void) | undefined;
  /** Chooses an image file to embed (the signature editor only). */
  onInsertImage?: (() => void) | undefined;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const saved = useRef<Range | null>(null);
  const [current, setCurrent] = useState<Current>({ colour: "", highlight: "", align: "left" });

  const command = (name: string, value?: string) => {
    editorRef.current?.focus();
    format(name, value);
    onChange();
  };

  /** Saves the selection and reads its current formatting (when a menu opens). */
  const capture = () => {
    const root = editorRef.current;
    saved.current = rangeIn(root);
    const node = saved.current?.startContainer;
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    const block = el && root?.contains(el) ? el : root;
    const family = saved.current ? matchFamily(commandValue("fontName")) : undefined;
    const size = saved.current ? matchSize(commandValue("fontSize")) : undefined;
    // Colours count only when the message sets one (the theme's text colour is not a choice).
    const own = (read: (e: HTMLElement) => string): string => {
      for (let n: Element | null = el; n && n !== root && root?.contains(n); n = n.parentElement) {
        const v = n instanceof HTMLElement ? read(n) : "";
        if (v !== "") return colourHex(v);
      }
      return "";
    };
    setCurrent({
      ...(family ? { family } : {}),
      ...(size ? { size } : {}),
      colour: own((e) => e.style.color || (e.getAttribute("color") ?? "")),
      highlight: own((e) => e.style.backgroundColor),
      align: block ? alignmentOf(getComputedStyle(block).textAlign) : "left",
    });
  };

  /** Closes the menu, puts the selection back and runs the command. */
  const apply = (done: () => void, name: string, value?: string) => {
    done();
    const root = editorRef.current;
    if (!root) return;
    restore(root, saved.current);
    format(name, value);
    saved.current = null;
    onChange();
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain border-b px-2 py-1 [scrollbar-width:thin]"
      >
        <ToolButton
          label="Undo"
          icon={<Undo2 className="size-4" aria-hidden />}
          onRun={() => {
            command("undo");
          }}
          shortcut="⌘/Ctrl + Z"
        />
        <ToolButton
          label="Redo"
          icon={<Redo2 className="size-4" aria-hidden />}
          onRun={() => {
            command("redo");
          }}
          shortcut="⌘/Ctrl + Shift + Z"
        />
        <Divider />
        <ToolMenu label="Font" icon={<Type className="size-4" aria-hidden />} host={host} onOpen={capture}>
          {(done) =>
            FONT_FAMILIES.map((f) => (
              <ChoiceItem
                key={f.value}
                label={f.label}
                checked={current.family === f.value}
                onSelect={() => {
                  apply(done, "fontName", f.value);
                }}
              >
                <span className="min-w-0 flex-1 truncate" style={{ fontFamily: f.value }}>
                  {f.label}
                </span>
              </ChoiceItem>
            ))
          }
        </ToolMenu>
        <ToolMenu label="Text size" icon={<ALargeSmall className="size-4" aria-hidden />} host={host} onOpen={capture}>
          {(done) =>
            FONT_SIZES.map((s) => (
              <ChoiceItem
                key={s.value}
                label={s.label}
                checked={current.size === s.value}
                onSelect={() => {
                  apply(done, "fontSize", s.value);
                }}
              />
            ))
          }
        </ToolMenu>
        <Divider />
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
        <ToolButton
          label="Strikethrough"
          icon={<Strikethrough className="size-4" aria-hidden />}
          onRun={() => {
            command("strikeThrough");
          }}
        />
        <ToolMenu
          label="Text colour"
          icon={<Baseline className="size-4" aria-hidden />}
          host={host}
          onOpen={capture}
          grid
        >
          {(done) =>
            TEXT_COLOURS.map((c) => (
              <Swatch
                key={c.value}
                colour={c}
                checked={current.colour === c.value}
                onSelect={() => {
                  apply(done, "foreColor", c.value);
                }}
              />
            ))
          }
        </ToolMenu>
        <ToolMenu
          label="Highlight"
          icon={<Highlighter className="size-4" aria-hidden />}
          host={host}
          onOpen={capture}
          grid
        >
          {(done) =>
            HIGHLIGHTS.map((c) => (
              <Swatch
                key={c.value}
                colour={c}
                checked={current.highlight === c.value}
                onSelect={() => {
                  apply(done, "hiliteColor", c.value);
                }}
              />
            ))
          }
        </ToolMenu>
        <Divider />
        <ToolMenu label="Align" icon={ALIGN_ICONS[current.align]} host={host} onOpen={capture}>
          {(done) =>
            ALIGNMENTS.map((a) => (
              <ChoiceItem
                key={a.value}
                label={a.label}
                checked={current.align === a.value}
                onSelect={() => {
                  apply(done, a.command);
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {ALIGN_ICONS[a.value]}
                  <span className="truncate">{a.label}</span>
                </span>
              </ChoiceItem>
            ))
          }
        </ToolMenu>
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
          label="Decrease indent"
          icon={<ListIndentDecrease className="size-4" aria-hidden />}
          onRun={() => {
            command("outdent");
          }}
        />
        <ToolButton
          label="Increase indent"
          icon={<ListIndentIncrease className="size-4" aria-hidden />}
          onRun={() => {
            command("indent");
          }}
        />
        <Divider />
        <ToolButton label="Link" icon={<Link className="size-4" aria-hidden />} onRun={onLink} shortcut="⌘/Ctrl + K" />
        {onInsertImage && (
          <ToolButton label="Insert image" icon={<ImagePlus className="size-4" aria-hidden />} onRun={onInsertImage} />
        )}
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
        <span className="min-w-2 flex-1" />
        {onInsertHtml && (
          <ToolButton label="Insert HTML" icon={<CodeXml className="size-4" aria-hidden />} onRun={onInsertHtml} />
        )}
      </div>
      {/* The layer the toolbar's menus open in (inside the composer, outside the scrolling row). */}
      <div ref={setHost} />
    </>
  );
}

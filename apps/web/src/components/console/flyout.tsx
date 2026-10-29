// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { PersonPhoto } from "../person-photo";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open modals, innermost last: Escape and Tab only act on the top one. */
const modals: symbol[] = [];

/**
 * Modal focus handling shared by the flyout and the confirm dialog: focus moves in (the element marked
 * `data-autofocus`, else the first control), Tab stays inside (even if the focused control disappears), Escape closes
 * the innermost one, the page behind doesn't scroll, and focus returns to whatever had it before (the row that
 * opened the panel) when it closes.
 */
function useModal(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const me = Symbol("modal");
    modals.push(me);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const target = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (modals[modals.length - 1] !== me || !ref.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const inside = ref.current.contains(document.activeElement);
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey && inside ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      modals.splice(modals.indexOf(me), 1);
      if (modals.length === 0) document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [ref]);
}

const closeClass =
  "inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * The flyout details panel: slides in from the right over the list (about 62% wide on large screens, full screen
 * on small ones), below the app bar. A modal dialog: Escape, the close button or a click on the dimmed list closes
 * it; focus is trapped inside and returns to the opener.
 */
export function Flyout({
  label,
  onClose,
  closeHref,
  size = "lg",
  children,
}: {
  label: string;
  onClose: () => void;
  /** When the panel lives in the URL, Close is a link there (it works before the page's scripts have loaded). */
  closeHref?: string;
  size?: "lg" | "md";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  const width = size === "lg" ? "lg:w-[62%] lg:min-w-[42rem] lg:max-w-[72rem]" : "sm:w-[32rem]";
  return (
    <div className="fixed inset-0 z-50 lg:top-12">
      <div aria-hidden onClick={onClose} className="absolute inset-0 bg-foreground/15 dark:bg-background/50" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`absolute inset-y-0 right-0 flex w-full flex-col border-l bg-background shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-10 motion-safe:duration-200 ${width}`}
      >
        <div className="flex shrink-0 justify-end px-3 pt-3">
          {closeHref ? (
            <Link href={closeHref} scroll={false} aria-label="Close" title="Close" className={closeClass}>
              <X className="size-5" aria-hidden />
            </Link>
          ) : (
            <button type="button" onClick={onClose} aria-label="Close" title="Close" className={closeClass}>
              <X className="size-5" aria-hidden />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-10 sm:px-10">{children}</div>
      </div>
    </div>
  );
}

/**
 * A flyout whose open state lives in the URL (`?mailbox=…`, `?new=1`): closing navigates to `closeHref`, so deep
 * links, reload and Back all work. The list underneath stays mounted, so its scroll and selection survive.
 */
export function UrlFlyout({
  label,
  closeHref,
  size,
  children,
}: {
  label: string;
  closeHref: string;
  size?: "lg" | "md";
  children: ReactNode;
}) {
  const router = useRouter();
  const close = useCallback(() => {
    router.push(closeHref, { scroll: false });
  }, [router, closeHref]);
  return (
    <Flyout label={label} onClose={close} closeHref={closeHref} {...(size ? { size } : {})}>
      {children}
    </Flyout>
  );
}

/** Two-step confirmation for destructive actions; it names the thing. Focus starts on Cancel. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  pendingLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  /** Resolves to an error message to show, or null when done (the caller closes the dialog). */
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onCancel);
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div aria-hidden onClick={onCancel} className="absolute inset-0 bg-foreground/30 dark:bg-background/70" />
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-d`}
        className="relative flex w-full max-w-md flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl"
      >
        <h2 id={`${id}-t`} className="am-h3">
          {title}
        </h2>
        <div id={`${id}-d`} className="am-body">
          {children}
        </div>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-autofocus
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-lg border px-3.5 text-[14px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void onConfirm().then((err) => {
                setPending(false);
                setError(err);
              });
            }}
            className="inline-flex h-9 items-center rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 text-[14px] font-medium text-destructive transition-colors hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Top of a details panel: a large circle with the photo (a person's or a shared mailbox's, ADR-0022) or initials, the
 * name, a coloured status line and inline action links. The name is the panel's heading.
 */
export function DetailHeader({
  initials,
  photoUrl = null,
  name,
  mono = false,
  status,
  actions,
}: {
  initials: string;
  photoUrl?: string | null;
  name: string;
  mono?: boolean;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
      <PersonPhoto
        src={photoUrl}
        label={initials}
        className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary font-display text-[22px] font-medium text-primary-foreground sm:size-24 sm:text-[30px]"
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className={`am-h2 min-w-0 break-all ${mono ? "font-mono text-[1.25rem] tracking-normal" : ""}`}>{name}</h2>
        {status && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{status}</div>}
        {actions && <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">{actions}</div>}
      </div>
    </div>
  );
}

const inlineAction =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] text-primary transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 [&>svg]:size-4";

/** An inline action in a panel header or a field's "Manage …" link that switches the panel to one of its tabs. */
export function TabLink({ tab, children, plain = false }: { tab: string; children: ReactNode; plain?: boolean }) {
  return (
    <button
      type="button"
      data-tab-target={tab}
      className={plain ? "text-[14px] text-primary underline-offset-2 hover:underline" : inlineAction}
    >
      {children}
    </button>
  );
}

/** An inline action that goes to another page. */
export function ActionLink({ href, children, plain = false }: { href: string; children: ReactNode; plain?: boolean }) {
  return (
    <Link href={href} className={plain ? "text-[14px] text-primary underline-offset-2 hover:underline" : inlineAction}>
      {children}
    </Link>
  );
}

export { inlineAction as inlineActionClass };

export type DetailTab = { id: string; label: string; content: ReactNode };

/**
 * Tabs in a details panel, underline style. The chosen tab goes into the URL (`tab=`) without a navigation, so a
 * reload keeps it; `data-tab-target` buttons anywhere in the panel switch tabs too.
 */
export function DetailTabs({
  tabs,
  initial,
  urlKey = "tab",
  label = "Details",
}: {
  tabs: DetailTab[];
  initial?: string | null;
  /** Search param that remembers the tab (null: don't touch the URL). */
  urlKey?: string | null;
  label?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(initial && tabs.some((t) => t.id === initial) ? initial : (tabs[0]?.id ?? ""));

  const select = useCallback(
    (tab: string) => {
      if (!tabs.some((t) => t.id === tab)) return;
      setCurrent(tab);
      if (!urlKey) return;
      const url = new URL(window.location.href);
      url.searchParams.set(urlKey, tab);
      window.history.replaceState(null, "", url);
    },
    [tabs, urlKey],
  );

  useEffect(() => {
    // Inline actions elsewhere in the same panel (or page) can switch tabs.
    const dialog = root.current?.closest("[role=dialog], main");
    if (!dialog) return;
    const onClick = (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-target]");
      const tab = target?.dataset.tabTarget;
      if (!tab) return;
      select(tab);
      document.getElementById(`${id}-tab-${tab}`)?.focus();
    };
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("click", onClick);
    };
  }, [select, id]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === current);
    const go = (n: number) => {
      e.preventDefault();
      const next = tabs[(n + tabs.length) % tabs.length];
      if (!next) return;
      select(next.id);
      document.getElementById(`${id}-tab-${next.id}`)?.focus();
    };
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tabs.length - 1);
  };

  return (
    <div ref={root} className="flex flex-col">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${id}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === current}
            aria-controls={`${id}-panel-${t.id}`}
            tabIndex={t.id === current ? 0 : -1}
            onClick={() => {
              select(t.id);
            }}
            className="relative -mb-px h-10 shrink-0 border-b-2 border-transparent px-2.5 text-[14px] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-selected:border-primary aria-selected:font-medium aria-selected:text-foreground"
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          id={`${id}-panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${t.id}`}
          hidden={t.id !== current}
          className="pt-6"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}

/** The two-column label / value / "Manage …" grid of a details panel. */
export function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-12 gap-y-7 sm:grid-cols-2">{children}</dl>;
}

export function Field({ label, children, manage }: { label: string; children: ReactNode; manage?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[14px] font-medium">{label}</dt>
      <dd className="min-w-0 text-[14px] break-words">{children}</dd>
      {manage && <dd className="mt-0.5">{manage}</dd>}
    </div>
  );
}

/** A heading inside a panel tab ("Contact information"). */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-9 flex flex-col gap-4 first:mt-0">
      <h3 id={id} className="am-h4">
        {title}
      </h3>
      {children}
    </section>
  );
}

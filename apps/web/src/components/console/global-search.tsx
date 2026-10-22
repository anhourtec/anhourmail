// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AtSign, Building2, Globe, Inbox, type LucideIcon, Search, User, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import type { SearchHit, SearchKind } from "@/server/search";

const KIND: Record<SearchKind, { label: string; icon: LucideIcon; mono: boolean }> = {
  mailbox: { label: "Mailboxes", icon: Inbox, mono: true },
  alias: { label: "Aliases", icon: AtSign, mono: true },
  domain: { label: "Domains", icon: Globe, mono: true },
  person: { label: "People", icon: User, mono: false },
  account: { label: "Customer accounts", icon: Building2, mono: false },
};

type State =
  { kind: "idle" } | { kind: "loading" } | { kind: "done"; hits: SearchHit[] } | { kind: "error"; message: string };

/** True when a key press is meant for a text field, not a shortcut. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]") !== null;
}

/**
 * The app bar's search: mailboxes, aliases, domains and people the person can see (and customer accounts for staff
 * who can look them up). The server does the matching and the permission checks; this box only lists what comes
 * back. `/` focuses it from anywhere; arrows move through the results, Enter opens one, Escape closes.
 */
export function GlobalSearch({ staff, onDone }: { staff: boolean; onDone?: () => void }) {
  const router = useRouter();
  const id = useId();
  const listId = `${id}-results`;
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [active, setActive] = useState(0);

  // `/` focuses the search unless the person is typing somewhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (!input.current?.offsetParent) return;
      e.preventDefault();
      input.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Debounced fetch; a newer query aborts the one in flight.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setState({ kind: "loading" });
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (res.status === 429) throw new Error("Search is busy. Try again in a moment.");
          if (!res.ok) throw new Error("Search isn't available right now.");
          const json = (await res.json()) as { data?: { hits?: SearchHit[] } };
          setState({ kind: "done", hits: json.data?.hits ?? [] });
          setActive(0);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : "Search isn't available right now.",
          });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // A click outside closes the results.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const hits = state.kind === "done" && query.trim().length >= 2 ? state.hits : [];

  const go = useCallback(
    (hit: SearchHit) => {
      // Only same-origin console paths (the server builds them; this is a second check).
      if (!hit.href.startsWith("/") || hit.href.startsWith("//")) return;
      setOpen(false);
      setQuery("");
      input.current?.blur();
      onDone?.();
      router.push(hit.href);
    },
    [router, onDone],
  );

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && hits.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp" && hits.length > 0) {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      const hit = hits[active];
      if (hit) {
        e.preventDefault();
        go(hit);
      }
    } else if (e.key === "Escape") {
      if (open && query) {
        e.preventDefault();
        setOpen(false);
      } else {
        setQuery("");
        input.current?.blur();
        onDone?.();
      }
    }
  }

  const showPanel = open && query.trim().length >= 2;
  const placeholder = staff ? "Search accounts, mailboxes, domains and people" : "Search mailboxes, domains and people";

  return (
    <div ref={box} className="relative w-full">
      <label htmlFor={`${id}-input`} className="sr-only">
        Search the console
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={input}
        id={`${id}-input`}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && hits[active] ? `${id}-hit-${String(active)}` : undefined}
        aria-keyshortcuts="/"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        className="h-8 w-full rounded-md border border-transparent bg-background pr-9 pl-8 text-[14px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQuery("");
            input.current?.focus();
          }}
          className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        <kbd
          aria-hidden
          className="am-num pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border px-1.5 text-[12px] text-muted-foreground sm:block"
        >
          /
        </kbd>
      )}

      {showPanel && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/5">
          {state.kind === "loading" || state.kind === "idle" ? (
            <p role="status" className="am-small px-3.5 py-3">
              Searching…
            </p>
          ) : state.kind === "error" ? (
            <p role="alert" className="am-small px-3.5 py-3 text-destructive">
              {state.message}
            </p>
          ) : hits.length === 0 ? (
            <p role="status" className="am-small px-3.5 py-3">
              Nothing matches “{query.trim()}”.
            </p>
          ) : null}
          <ul id={listId} role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto py-1">
            {hits.map((hit, i) => {
              const k = KIND[hit.kind];
              const Icon = k.icon;
              const first = i === 0 || hits[i - 1]?.kind !== hit.kind;
              return (
                <li key={`${hit.kind}-${hit.id}`} role="presentation">
                  {first && (
                    <div role="presentation" className="am-micro px-3.5 pt-2 pb-1 font-medium">
                      {k.label}
                    </div>
                  )}
                  <div
                    id={`${id}-hit-${String(i)}`}
                    role="option"
                    data-kind={hit.kind}
                    aria-selected={i === active}
                    tabIndex={-1}
                    onPointerMove={() => {
                      setActive(i);
                    }}
                    onClick={() => {
                      go(hit);
                    }}
                    className="mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 aria-selected:bg-accent"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      <span className={`truncate text-[14px] ${k.mono ? "am-code" : ""}`}>{hit.label}</span>
                      <span className="am-micro truncate">{hit.detail}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

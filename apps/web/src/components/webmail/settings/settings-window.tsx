// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowLeft, ChevronRight, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";
import type { SignatureSet } from "@anhourmail/shared/signatures";
import type { WebmailPreferences } from "@anhourmail/shared/webmail";

import type { Folder, Identity, MailClient, SettingsOverview } from "../mail-client";
import { ExportPanel } from "./export-panel";
import { AccountPanel, ForwardingPanel, JunkPanel, RepliesPanel, WritingPanel } from "./panels-mail";
import { AppearancePanel, ReadingPanel, RegionPanel } from "./panels-view";
import { matchSections, SECTIONS, type SectionId } from "./sections";

/** Panels that need the mail server's side of the settings (loaded when the window opens). */
const NEEDS_SERVER: ReadonlySet<SectionId> = new Set(["writing", "replies", "forwarding", "junk", "account"]);

function PanelSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading settings</span>
      <Bone className="h-4 w-40" />
      <Bone className="h-28 w-full rounded-xl" />
      <Bone className="h-4 w-32" />
      <Bone className="h-40 w-full rounded-xl" />
    </div>
  );
}

/**
 * The webmail settings window (gear in the sidebar, or `,`): a search box, the groups, and the chosen group's panel.
 * A large dialog on wide screens; full screen on phones, where the groups and the panel are two steps. Display
 * preferences apply at once (the mail behind updates live); mail-server settings save with their own button.
 */
export function SettingsWindow({
  client,
  preferences,
  folders,
  consoleHref,
  shortcuts,
  onChange,
  onIdentitiesChanged,
  onSignaturesChanged,
  onSignOut,
  onClose,
}: {
  client: MailClient;
  preferences: WebmailPreferences;
  folders: Folder[];
  consoleHref: string;
  shortcuts: readonly [string, string][];
  onChange: (patch: Partial<WebmailPreferences>) => void;
  onIdentitiesChanged: (list: Identity[]) => void;
  onSignaturesChanged: (set: SignatureSet) => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<SectionId>("appearance");
  /** Phones: the list of groups first, then one panel. */
  const [step, setStep] = useState<"list" | "panel">("list");
  const [data, setData] = useState<SettingsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();
  const matches = useMemo(() => matchSections(query), [query]);
  const shown = matches.some((m) => m.id === current) ? current : (matches[0]?.id ?? current);
  const section = SECTIONS.find((s) => s.id === shown) ?? SECTIONS[0];

  useEffect(() => {
    opener.current = document.activeElement;
    search.current?.focus();
    let live = true;
    client
      .settings()
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setError("Some settings couldn't be loaded. Close and open settings to try again.");
      });
    return () => {
      live = false;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [client]);

  const identities = (list: Identity[]) => {
    setData((d) => (d ? { ...d, identities: list } : d));
    onIdentitiesChanged(list);
  };

  const pick = (next: SectionId) => {
    setCurrent(next);
    setStep("panel");
  };

  /** Vertical tabs: arrow keys move between groups (and show them), Home/End jump. */
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = matches.length;
    const to =
      e.key === "ArrowDown"
        ? (i + 1) % n
        : e.key === "ArrowUp"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const target = matches[to];
    if (!target) return;
    setCurrent(target.id);
    document.getElementById(`${id}-tab-${target.id}`)?.focus();
  };

  const timeZone =
    preferences.timeZone === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : preferences.timeZone;

  const panel = () => {
    if (NEEDS_SERVER.has(shown) && !data) {
      return error ? (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      ) : (
        <PanelSkeleton />
      );
    }
    switch (shown) {
      case "appearance":
        return <AppearancePanel prefs={preferences} onChange={onChange} />;
      case "reading":
        return <ReadingPanel prefs={preferences} onChange={onChange} />;
      case "region":
        return <RegionPanel prefs={preferences} onChange={onChange} folders={folders} shortcuts={shortcuts} />;
      case "export":
        return <ExportPanel folders={folders} />;
      default:
        break;
    }
    if (!data) return null;
    switch (shown) {
      case "writing":
        return (
          <WritingPanel
            prefs={preferences}
            onChange={onChange}
            data={data}
            client={client}
            onSignatures={onSignaturesChanged}
          />
        );
      case "replies":
        return <RepliesPanel data={data} client={client} timeZone={timeZone} onSaved={setData} />;
      case "forwarding":
        return <ForwardingPanel data={data} client={client} onSaved={setData} />;
      case "junk":
        return <JunkPanel data={data} client={client} onSaved={setData} />;
      case "account":
        return (
          <AccountPanel
            prefs={preferences}
            onChange={onChange}
            data={data}
            client={client}
            consoleHref={consoleHref}
            onIdentities={identities}
            onSignOut={onSignOut}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-stretch justify-center md:items-center md:p-6"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        // Keep Tab inside the window (it's modal).
        if (e.key !== "Tab") return;
        const box = dialog.current;
        if (!box) return;
        const items = Array.from(
          box.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"),
        ).filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.offsetParent !== null);
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <button
        type="button"
        aria-label="Close settings"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 hidden bg-foreground/30 md:block"
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="relative flex h-dvh w-full flex-col overflow-hidden bg-popover md:h-[min(46rem,calc(100dvh-3rem))] md:max-w-5xl md:rounded-2xl md:border md:shadow-2xl"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          {step === "panel" && (
            <button
              type="button"
              onClick={() => {
                setStep("list");
              }}
              aria-label="Back to all settings"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </button>
          )}
          <h2 id={`${id}-title`} className="am-h3 flex-1">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[17rem_minmax(0,1fr)]">
          <nav
            aria-label="Settings groups"
            className={`min-h-0 flex-col gap-3 overflow-y-auto border-r p-3 ${step === "panel" ? "hidden md:flex" : "flex"}`}
          >
            <label className="relative flex items-center">
              <span className="sr-only">Search settings</span>
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
              <input
                ref={search}
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                aria-controls={`${id}-tabs`}
                className="h-9 w-full rounded-lg border bg-background pr-3 pl-8 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            {matches.length === 0 ? (
              <p className="am-small px-1" role="status">
                No settings match “{query.trim()}”.
              </p>
            ) : (
              <div
                id={`${id}-tabs`}
                role="tablist"
                aria-orientation="vertical"
                aria-label="Settings"
                className="flex flex-col gap-0.5"
              >
                {matches.map((s, i) => {
                  const on = s.id === shown;
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.id}
                      id={`${id}-tab-${s.id}`}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      aria-controls={`${id}-panel`}
                      tabIndex={on ? 0 : -1}
                      onKeyDown={(e) => {
                        onTabKey(e, i);
                      }}
                      onClick={() => {
                        pick(s.id);
                      }}
                      className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                        on ? "md:bg-accent" : "hover:bg-accent/60"
                      }`}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={`text-[14px] ${on ? "font-medium" : ""}`}>{s.label}</span>
                        <span className="am-micro truncate md:hidden">{s.summary}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground md:hidden" aria-hidden />
                    </button>
                  );
                })}
              </div>
            )}
          </nav>
          <section
            id={`${id}-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-${section?.id ?? "appearance"}`}
            className={`min-h-0 overflow-y-auto px-4 py-5 md:px-8 ${step === "list" ? "hidden md:block" : "block"}`}
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-5">
              <div className="flex flex-col gap-1">
                <h2 className="am-h2">{section?.label}</h2>
                <p className="am-small">{section?.summary}</p>
              </div>
              {panel()}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

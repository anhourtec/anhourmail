// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Monitor, Moon, Settings2, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { AccountMenu, Avatar, type MenuAccount, type MenuUser } from "./account-menu";
import { PanelSurface, usePopover } from "./popover";

const iconButton =
  "inline-flex size-9 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground";

const noop = () => () => undefined;
const CYCLE = { light: "dark", dark: "system", system: "light" } as const;
const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

/** One button that cycles Light → Dark → System; its icon shows the current choice. */
function ThemeCycle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const current = mounted && (theme === "light" || theme === "dark") ? theme : "system";
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;
  return (
    <button
      type="button"
      onClick={() => {
        setTheme(CYCLE[current]);
      }}
      aria-label={`Theme: ${THEME_LABEL[current]}. Switch to ${THEME_LABEL[CYCLE[current]]}`}
      title={`Theme: ${THEME_LABEL[current]}`}
      className={iconButton}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="am-micro font-medium">{label}</span>
      <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-lg border p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => {
              onChange(o.value);
            }}
            className="h-7 rounded-md text-[13px] text-muted-foreground transition-colors aria-checked:bg-accent aria-checked:text-foreground hover:text-foreground"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Console preferences: theme and sidebar width (both remembered), with a reset. */
function Preferences({ compact, setCompact }: { compact: boolean; setCompact: (c: boolean) => void }) {
  const { open: prefsOpen, toggle: prefsToggle, trigger: prefsTrigger, panel: prefsPanel } = usePopover();
  const { theme, setTheme } = useTheme();
  return (
    <div className="relative">
      <button
        ref={prefsTrigger}
        type="button"
        onClick={prefsToggle}
        aria-haspopup="dialog"
        aria-expanded={prefsOpen}
        aria-label="Preferences"
        title="Preferences"
        className={iconButton}
      >
        <Settings2 className="size-4" aria-hidden />
      </button>
      {prefsOpen && (
        <div ref={prefsPanel} role="dialog" aria-label="Preferences" className="absolute top-11 right-0">
          <PanelSurface className="flex w-72 flex-col gap-4 p-3.5">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-[14px]">Preferences</span>
              <span className="am-micro">Saved in this browser.</span>
            </div>
            <Segmented
              label="Theme"
              value={theme === "light" || theme === "dark" ? theme : "system"}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ]}
              onChange={setTheme}
            />
            <span className="hidden lg:contents">
              <Segmented
                label="Sidebar"
                value={compact ? "compact" : "expanded"}
                options={[
                  { value: "expanded", label: "Expanded" },
                  { value: "compact", label: "Icons only" },
                ]}
                onChange={(v) => {
                  setCompact(v === "compact");
                }}
              />
            </span>
            <button
              type="button"
              onClick={() => {
                setTheme("system");
                setCompact(false);
              }}
              className="h-8 rounded-lg border text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Restore defaults
            </button>
          </PanelSurface>
        </div>
      )}
    </div>
  );
}

/** The header's right side: preferences, theme, and the person's menu. */
export function HeaderActions({
  user,
  accounts,
  siteUrl,
  compact,
  setCompact,
}: {
  user: MenuUser;
  accounts: MenuAccount[];
  siteUrl: string;
  compact: boolean;
  setCompact: (c: boolean) => void;
}) {
  const { open: menuOpen, toggle: menuToggle, close: menuClose, trigger: menuTrigger, panel: menuPanel } = usePopover();
  return (
    <div className="flex items-center gap-2">
      <Preferences compact={compact} setCompact={setCompact} />
      <ThemeCycle />
      <div className="relative">
        <button
          ref={menuTrigger}
          type="button"
          onClick={menuToggle}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Your account"
          className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar name={user.name} email={user.email} size="md" />
        </button>
        {menuOpen && (
          <div ref={menuPanel} className="absolute top-11 right-0">
            <PanelSurface>
              <AccountMenu
                user={user}
                accounts={accounts}
                siteUrl={siteUrl}
                onNavigate={() => {
                  menuClose(false);
                }}
              />
            </PanelSurface>
          </div>
        )}
      </div>
    </div>
  );
}

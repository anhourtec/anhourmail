// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sidebar preferences, kept in cookies so the server renders the first paint right. Plain module on purpose:
 * constants exported from a "use client" file reach server code as client references, not values.
 */

/** "compact" or "expanded". */
export const SIDEBAR_COOKIE = "am-sidebar";

/** Comma-separated ids of the sections the person has collapsed. */
export const GROUPS_COOKIE = "am-sidebar-closed";

/** Browser only: writes a sidebar cookie (a year; `Secure` on https). */
export function writeSidebarCookie(name: string, value: string): void {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax${secure}`;
}

/** Browser only: forgets the sidebar preferences (on sign-out, so a shared browser keeps no account ids). */
export function clearSidebarCookies(): void {
  for (const name of [SIDEBAR_COOKIE, GROUPS_COOKIE]) document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

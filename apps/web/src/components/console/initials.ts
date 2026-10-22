// SPDX-License-Identifier: AGPL-3.0-only
/** Two letters for a details panel's circle: from a name, an address's local part, or a domain. */
export function initialsOf(text: string): string {
  const base = text.includes("@") ? (text.split("@")[0] ?? text) : text;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase() || "?";
}

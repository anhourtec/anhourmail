// SPDX-License-Identifier: AGPL-3.0-only
/** One string value from a page's search params: arrays and empty values count as missing; at most 100 chars. */
export function param(sp: Record<string, string | string[] | undefined>, key: string): string | null {
  const v = sp[key];
  return typeof v === "string" && v !== "" ? v.slice(0, 100) : null;
}

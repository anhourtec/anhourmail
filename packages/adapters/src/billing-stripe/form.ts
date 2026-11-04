// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The processor's request encoding: `application/x-www-form-urlencoded` with bracketed nesting
 * (`items[0][price]=…`, `metadata[account_id]=…`, `expand[]=…` for arrays of scalars under `expand`). Undefined and
 * null are left out; booleans are `true`/`false`.
 */

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

function walk(prefix: string, value: FormValue, out: [string, string][]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    // `expand` takes `expand[]=a&expand[]=b`; every other list is indexed (`items[0][price]`).
    const plain = prefix === "expand" || prefix.endsWith("[expand]");
    value.forEach((v, i) => {
      walk(plain ? `${prefix}[]` : `${prefix}[${String(i)}]`, v, out);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(prefix === "" ? k : `${prefix}[${k}]`, v, out);
    return;
  }
  out.push([prefix, typeof value === "boolean" ? (value ? "true" : "false") : String(value)]);
}

/** Encodes a nested object as a form body (key order kept, for stable idempotent requests). */
export function encodeForm(params: Record<string, FormValue>): string {
  const pairs: [string, string][] = [];
  walk("", params, pairs);
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%5B/g, "[").replace(/%5D/g, "]")}=${encodeURIComponent(v)}`)
    .join("&");
}

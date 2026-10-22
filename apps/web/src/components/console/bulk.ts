// SPDX-License-Identifier: AGPL-3.0-only
import { callApi } from "../api";

export type BulkResult = { done: number; failed: string[] };

/**
 * Runs one API call per selected item, one after another (the server checks each: permission, scope and guard
 * rails), and collects what failed. There is no bulk endpoint, so a partial result is possible and is reported.
 */
export async function runBulk(
  ids: readonly string[],
  call: (id: string) => { url: string; method: "POST" | "PATCH" | "DELETE"; body?: unknown },
): Promise<BulkResult> {
  const failed: string[] = [];
  let done = 0;
  for (const id of ids) {
    const c = call(id);
    const res = await callApi(c.url, { method: c.method, ...(c.body === undefined ? {} : { body: c.body }) });
    if (res.ok) done += 1;
    else failed.push(res.message);
  }
  return { done, failed };
}

/** One plain sentence about a bulk run: "Suspended 3 mailboxes." / "2 done; 1 couldn't be changed: …". */
export function bulkMessage(r: BulkResult, verb: string, one: string, many: string): string {
  const noun = (n: number) => `${String(n)} ${n === 1 ? one : many}`;
  if (r.failed.length === 0) return `${verb} ${noun(r.done)}.`;
  const reasons = [...new Set(r.failed)].join(" ");
  return r.done > 0
    ? `${verb} ${noun(r.done)}. ${noun(r.failed.length)} couldn't be changed: ${reasons}`
    : `Nothing changed: ${reasons}`;
}

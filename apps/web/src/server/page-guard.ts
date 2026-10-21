// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { notFound } from "next/navigation";

import { ForbiddenError, NotFoundError } from "@anhourmail/core";

/**
 * Runs a page's service calls. Out-of-scope ids render the 404 page (never confirm another account's ids); a
 * missing permission returns null so the page can say so.
 */
export async function forPage<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}

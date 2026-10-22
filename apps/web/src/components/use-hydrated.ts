// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => undefined;

/**
 * False during server rendering and before hydration, true once React runs in the browser. Password forms keep
 * their submit button disabled until then, so pressing Enter before the JavaScript loads can't submit the form
 * natively (forms also use `method="post"`, so a native submit never puts a password in a URL).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

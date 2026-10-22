// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useSyncExternalStore } from "react";

import { greetingFor } from "./greeting-text";

const noop = () => () => undefined;

/**
 * "Good morning, Pat": the time of day comes from the person's own clock, so the server renders a neutral "Hello"
 * and the browser swaps in the greeting once it runs.
 */
export function Greeting({ name }: { name: string }) {
  const greeting = useSyncExternalStore(
    noop,
    () => greetingFor(new Date().getHours()),
    () => "Hello",
  );
  return (
    <h1 className="am-h1">
      {greeting}, {name}
    </h1>
  );
}

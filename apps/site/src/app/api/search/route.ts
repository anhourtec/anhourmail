// SPDX-License-Identifier: AGPL-3.0-only
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

/** Docs search runs here, on our own server (Orama, in memory). No third-party search service. */
export const { GET } = createFromSource(source, { language: "english" });

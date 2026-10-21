// SPDX-License-Identifier: AGPL-3.0-only
import { Wordmark } from "@anhourmail/ui/wordmark";

/** App wordmark (shared component). `area` names the product area, e.g. "Webmail". */
export function BrandMark({ area }: { area?: string }) {
  return <Wordmark {...(area ? { suffix: area } : {})} />;
}

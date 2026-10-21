// SPDX-License-Identifier: AGPL-3.0-only
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { ClientSettingsTable, DnsRecordTable, PlanTable, SendLimitsTable, Value } from "./facts";

/** Components available in every docs page without imports. */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Value,
    ClientSettingsTable,
    DnsRecordTable,
    PlanTable,
    SendLimitsTable,
    ...components,
  };
}

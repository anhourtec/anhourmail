// SPDX-License-Identifier: AGPL-3.0-only
import { ListPageSkeleton } from "@/components/console/list-page-skeleton";

/** Mirrors the audit log: header, command bar, filter chips (area, who, result, dates), entries. */
export default function Loading() {
  return <ListPageSkeleton label="Loading the audit log" actions={1} search={false} chips={6} rows={8} columns={5} />;
}

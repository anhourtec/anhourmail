// SPDX-License-Identifier: AGPL-3.0-only
import { ListPageSkeleton } from "@/components/console/list-page-skeleton";

/** Mirrors the aliases page: header and usage line, command bar, type chips, list with a checkbox column. */
export default function Loading() {
  return <ListPageSkeleton label="Loading aliases" chips={4} rows={5} columns={4} checkbox />;
}

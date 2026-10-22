// SPDX-License-Identifier: AGPL-3.0-only
import { ListPageSkeleton } from "@/components/console/list-page-skeleton";

/** Mirrors the domains page: header, command bar, status chips, list. */
export default function Loading() {
  return <ListPageSkeleton label="Loading domains" chips={2} rows={3} columns={3} />;
}

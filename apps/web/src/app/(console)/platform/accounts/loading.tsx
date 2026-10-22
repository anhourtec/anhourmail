// SPDX-License-Identifier: AGPL-3.0-only
import { ListPageSkeleton } from "@/components/console/list-page-skeleton";

/** Mirrors Customer accounts: header, command bar with the search form, result count, list. */
export default function Loading() {
  return <ListPageSkeleton label="Loading customer accounts" actions={1} rows={8} columns={6} />;
}

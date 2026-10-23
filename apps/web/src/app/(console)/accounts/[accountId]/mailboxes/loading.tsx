// SPDX-License-Identifier: AGPL-3.0-only
import { ListPageSkeleton } from "@/components/console/list-page-skeleton";

/** Mirrors the mailboxes page: header, account storage card, command bar, status chips, list with a checkbox column. */
export default function Loading() {
  return <ListPageSkeleton label="Loading mailboxes" chips={3} rows={5} columns={4} checkbox summary />;
}

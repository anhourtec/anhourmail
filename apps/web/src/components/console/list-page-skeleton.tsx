// SPDX-License-Identifier: AGPL-3.0-only
import {
  Bone,
  CommandBarSkeleton,
  FilterChipsSkeleton,
  ListSkeleton,
  PageHeaderSkeleton,
  SkeletonPage,
} from "@anhourmail/ui/skeletons";

/**
 * Loading state of a console list page (page template): breadcrumb and title, command bar with its search box,
 * filter chips, then the list rows at their real height.
 */
export function ListPageSkeleton({
  label,
  actions = 2,
  chips = 0,
  rows = 6,
  columns = 3,
  checkbox = false,
  lead = true,
  search = true,
  summary = false,
}: {
  label: string;
  actions?: number;
  chips?: number;
  rows?: number;
  columns?: number;
  checkbox?: boolean;
  lead?: boolean;
  search?: boolean;
  /** A summary card under the header (the Mailboxes page's account storage line and bar). */
  summary?: boolean;
}) {
  return (
    <SkeletonPage label={label}>
      <PageHeaderSkeleton lead={lead} />
      {summary && (
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
          <Bone className="h-4 w-full max-w-xl" />
          <Bone className="h-1.5 w-full max-w-md rounded-full" />
        </div>
      )}
      <CommandBarSkeleton actions={actions} search={search} />
      {chips > 0 && <FilterChipsSkeleton chips={chips} />}
      <ListSkeleton rows={rows} columns={columns} checkbox={checkbox} />
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import {
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
}: {
  label: string;
  actions?: number;
  chips?: number;
  rows?: number;
  columns?: number;
  checkbox?: boolean;
  lead?: boolean;
  search?: boolean;
}) {
  return (
    <SkeletonPage label={label}>
      <PageHeaderSkeleton lead={lead} />
      <CommandBarSkeleton actions={actions} search={search} />
      {chips > 0 && <FilterChipsSkeleton chips={chips} />}
      <ListSkeleton rows={rows} columns={columns} checkbox={checkbox} />
    </SkeletonPage>
  );
}

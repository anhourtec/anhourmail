// SPDX-License-Identifier: AGPL-3.0-only
import {
  Bone,
  CommandBarSkeleton,
  FilterChipsSkeleton,
  ListSkeleton,
  PageHeaderSkeleton,
  SkeletonPage,
} from "@anhourmail/ui/skeletons";

/** Mirrors People and roles: header, command bar, role chips, the people list, then pending invites. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading people">
      <PageHeaderSkeleton />
      <CommandBarSkeleton />
      <FilterChipsSkeleton chips={4} />
      <ListSkeleton rows={5} columns={4} checkbox />
      <Bone className="mt-4 h-6 w-40" />
      <ListSkeleton rows={2} columns={4} />
    </SkeletonPage>
  );
}

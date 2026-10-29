// SPDX-License-Identifier: AGPL-3.0-only
import { ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Pending deletions: header and the table of accounts. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading pending deletions">
      <PageHeaderSkeleton />
      <ListSkeleton rows={4} columns={4} />
    </SkeletonPage>
  );
}

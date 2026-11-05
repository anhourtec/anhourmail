// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors one batch: header with the report button, the per-mailbox list, the note below. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the import batch">
      <PageHeaderSkeleton actions={1} />
      <ListSkeleton rows={3} columns={4} />
      <Bone className="h-3.5 w-80" />
    </SkeletonPage>
  );
}

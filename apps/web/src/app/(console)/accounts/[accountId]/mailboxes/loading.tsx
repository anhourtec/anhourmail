// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading mailboxes">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4 rounded-xl border p-5">
        <Bone className="h-5 w-32" />
        <div className="flex gap-2">
          <Bone className="h-10 w-56 rounded-lg" />
          <Bone className="h-10 w-64 rounded-lg" />
        </div>
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
      <TableSkeleton rows={4} columns={4} />
    </SkeletonPage>
  );
}

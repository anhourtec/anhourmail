// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading domains">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-2">
        <Bone className="h-4 w-28" />
        <div className="flex gap-2">
          <Bone className="h-10 w-full max-w-sm rounded-lg" />
          <Bone className="h-10 w-32 rounded-lg" />
        </div>
      </div>
      <TableSkeleton rows={3} columns={3} />
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading aliases">
      <PageHeaderSkeleton />
      <Bone className="h-4 w-64" />
      <div className="flex flex-col gap-4 rounded-xl border p-5">
        <div className="flex justify-between gap-3">
          <Bone className="h-5 w-24" />
          <Bone className="h-9 w-56 rounded-lg" />
        </div>
        <div className="flex gap-2">
          <Bone className="h-10 w-56 rounded-lg" />
          <Bone className="h-10 w-64 rounded-lg" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Bone className="h-10 rounded-lg" />
          <Bone className="h-10 rounded-lg" />
        </div>
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
      <TableSkeleton rows={4} columns={4} />
    </SkeletonPage>
  );
}

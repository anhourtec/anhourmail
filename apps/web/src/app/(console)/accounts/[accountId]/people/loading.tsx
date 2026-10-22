// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading people">
      <PageHeaderSkeleton breadcrumbs />
      <Bone className="h-4 w-56" />
      <div className="flex flex-col gap-4 rounded-xl border p-5">
        <Bone className="h-5 w-32" />
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
          <Bone className="h-10 rounded-lg" />
          <Bone className="h-10 rounded-lg" />
        </div>
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
      <Bone className="h-5 w-20" />
      <TableSkeleton rows={4} columns={5} />
      <Bone className="h-5 w-36" />
      <TableSkeleton rows={2} columns={4} />
    </SkeletonPage>
  );
}

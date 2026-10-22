// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading the account">
      <PageHeaderSkeleton breadcrumbs lead={false} />
      <Bone className="h-12 w-full max-w-prose rounded-xl" />
      <div className="grid gap-4 rounded-xl border p-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-3 w-16" />
            <Bone className="h-5 w-32" />
          </div>
        ))}
      </div>
      <Bone className="h-5 w-24" />
      <TableSkeleton rows={3} columns={4} />
      <Bone className="h-5 w-24" />
      <Bone className="h-24 w-full rounded-xl" />
      <Bone className="h-5 w-28" />
      <TableSkeleton rows={3} columns={3} />
    </SkeletonPage>
  );
}

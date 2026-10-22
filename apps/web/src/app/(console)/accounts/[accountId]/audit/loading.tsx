// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading the audit log">
      <PageHeaderSkeleton breadcrumbs />
      <div className="flex flex-col gap-4 rounded-xl border p-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Bone className="h-4 w-16" />
              <Bone className="h-10 rounded-lg" />
            </div>
          ))}
        </div>
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
      <TableSkeleton rows={8} columns={6} />
    </SkeletonPage>
  );
}

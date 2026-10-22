// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading customer accounts">
      <PageHeaderSkeleton breadcrumbs />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Bone className="h-10 w-full rounded-lg sm:max-w-md" />
        <Bone className="h-10 w-28 rounded-lg" />
      </div>
      <Bone className="h-4 w-32" />
      <TableSkeleton rows={8} columns={6} />
    </SkeletonPage>
  );
}

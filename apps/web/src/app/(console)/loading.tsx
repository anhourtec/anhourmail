// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="border-b">
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6 lg:px-8">
          <Bone className="h-4 w-28" />
          <div className="flex gap-2">
            <Bone className="h-9 w-24 rounded-lg" />
            <Bone className="h-9 w-24 rounded-lg" />
          </div>
        </div>
      </div>
      <div className="flex w-full flex-1 flex-col lg:flex-row">
        <div className="hidden border-r bg-sidebar p-4 lg:block lg:w-64">
          <div className="flex flex-col gap-2">
            {Array.from({ length: 7 }, (_, i) => (
              <Bone key={i} className="h-7 w-full rounded-lg" />
            ))}
          </div>
        </div>
        <main className="flex-1 px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
          <SkeletonPage label="Loading console">
            <PageHeaderSkeleton />
            <TableSkeleton rows={6} columns={3} />
          </SkeletonPage>
        </main>
      </div>
    </div>
  );
}

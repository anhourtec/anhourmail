// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TableSkeleton } from "@anhourmail/ui/skeletons";

/** Mirrors the console frame: full-height sidebar (wide screens), header, content. */
export default function Loading() {
  return (
    <div className="flex min-h-dvh w-full">
      <div className="hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center border-b px-4">
          <Bone className="h-4 w-28" />
        </div>
        <div className="flex flex-col gap-2 p-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Bone key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center justify-end gap-2 border-b px-4 sm:px-6 lg:px-8">
          <Bone className="h-9 w-24 rounded-lg" />
          <Bone className="h-9 w-24 rounded-lg" />
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

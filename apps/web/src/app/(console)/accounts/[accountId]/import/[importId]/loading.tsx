// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors one import: header, the status box (status, bar, four counts, actions), details, then the folders list. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the import">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4 rounded-xl border p-4">
        <Bone className="h-6 w-40" />
        <Bone className="h-1.5 w-full rounded-full" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Bone className="h-3 w-16" />
              <Bone className="h-5 w-20" />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Bone className="h-10 w-28 rounded-lg" />
          <Bone className="h-10 w-36 rounded-lg" />
        </div>
      </div>
      <Bone className="mt-2 h-6 w-24" />
      <Bone className="h-24 w-full max-w-lg" />
      <Bone className="mt-2 h-6 w-24" />
      <ListSkeleton rows={4} columns={3} />
    </SkeletonPage>
  );
}

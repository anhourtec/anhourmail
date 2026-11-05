// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Usage: header, the two tabs, four usage cards (icon and title, the meter, the note, the link), the "Need more room?" card. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading usage">
      <PageHeaderSkeleton />
      <div className="flex gap-6 border-b pb-3">
        <Bone className="h-5 w-36" />
        <Bone className="h-5 w-16" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-4 rounded-2xl border p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <Bone className="size-10 rounded-xl" />
              <Bone className="h-5 w-28" />
            </div>
            <Bone className="h-5 w-24" />
            <Bone className="h-1.5 w-full rounded-full" />
            <Bone className="h-3.5 w-3/4" />
            <Bone className="h-4 w-32" />
          </div>
        ))}
      </div>
      <Bone className="h-24 w-full rounded-2xl" />
    </SkeletonPage>
  );
}

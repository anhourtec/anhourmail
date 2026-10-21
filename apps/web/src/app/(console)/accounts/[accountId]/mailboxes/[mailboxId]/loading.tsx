// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading mailbox">
      <PageHeaderSkeleton />
      <div className="grid gap-4 rounded-xl border p-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-3 w-16" />
            <Bone className="h-5 w-32" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Bone className="h-5 w-24" />
        <Bone className="h-10 w-48 rounded-lg" />
      </div>
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading domain">
      <PageHeaderSkeleton />
      <Bone className="h-6 w-48 rounded-full" />
      {[5, 6].map((rows, g) => (
        <div key={g} className="flex flex-col gap-3">
          <Bone className="h-5 w-40" />
          <div className="divide-y rounded-xl border">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex gap-4 px-4 py-4">
                <Bone className="h-4 w-12" />
                <Bone className="h-4 w-1/4" />
                <Bone className="h-4 flex-1" />
                <Bone className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </SkeletonPage>
  );
}

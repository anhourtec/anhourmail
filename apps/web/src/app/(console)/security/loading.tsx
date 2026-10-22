// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Security: header, sign-in methods (two rows with actions), sessions list, then recent activity. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading security">
      <PageHeaderSkeleton />
      <Bone className="mt-2 h-6 w-48" />
      {[0, 1].map((i) => (
        <div key={i} className="flex items-start justify-between gap-4 border-b py-4">
          <div className="flex flex-1 gap-3">
            <Bone className="size-5 rounded-md" />
            <div className="flex flex-1 flex-col gap-2">
              <Bone className="h-4 w-44" />
              <Bone className="h-3.5 w-full max-w-md" />
              <Bone className="h-3.5 w-16" />
            </div>
          </div>
          <Bone className="h-10 w-28 rounded-lg" />
        </div>
      ))}
      <Bone className="mt-4 h-6 w-56" />
      <ListSkeleton rows={2} columns={2} />
      <Bone className="mt-4 h-6 w-40" />
      <ListSkeleton rows={6} columns={3} />
    </SkeletonPage>
  );
}

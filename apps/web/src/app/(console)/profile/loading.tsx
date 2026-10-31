// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/**
 * Mirrors Profile: header, name, photo with its buttons, the name with Edit name, the note and sign-in email, then the
 * details and Edit.
 */
export default function Loading() {
  return (
    <SkeletonPage label="Loading your profile">
      <PageHeaderSkeleton />
      <Bone className="h-6 w-48" />
      <div className="flex items-center gap-4">
        <Bone className="size-16 rounded-full sm:size-20" />
        <div className="flex flex-col gap-2">
          <Bone className="h-10 w-40 rounded-lg" />
          <Bone className="h-3 w-56" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Bone className="h-3 w-12" />
        <Bone className="h-4 w-40" />
        <Bone className="h-10 w-32 rounded-lg" />
      </div>
      <Bone className="h-3.5 w-full max-w-prose" />
      <Bone className="h-3.5 w-40" />
      <Bone className="h-4 w-64" />
      <Bone className="mt-4 h-6 w-40" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-4">
          <Bone className="h-3.5 w-32" />
          <Bone className="h-3.5 w-48" />
        </div>
      ))}
      <Bone className="h-10 w-32 rounded-lg" />
    </SkeletonPage>
  );
}

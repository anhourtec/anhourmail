// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Profile: header, name and sign-in email, then the profile details list and its Edit button. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading your profile">
      <PageHeaderSkeleton />
      <Bone className="h-6 w-48" />
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

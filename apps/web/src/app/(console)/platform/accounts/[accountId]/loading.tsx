// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors a customer account for staff: header, the audit notice, the suspension action, the field grid, tabs and the people list. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the account">
      <PageHeaderSkeleton lead={false} />
      <Bone className="h-12 w-full max-w-prose rounded-lg" />
      <Bone className="h-9 w-40 rounded-lg" />
      <div className="grid gap-x-12 gap-y-7 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-3.5 w-20" />
            <Bone className="h-4 w-36" />
          </div>
        ))}
      </div>
      <div className="flex gap-5 border-b pb-2">
        <Bone className="h-4 w-20" />
        <Bone className="h-4 w-24" />
        <Bone className="h-4 w-24" />
      </div>
      <ListSkeleton rows={3} columns={4} />
    </SkeletonPage>
  );
}

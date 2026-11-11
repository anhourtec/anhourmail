// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/**
 * Mirrors a customer account for staff: header, the audit notice, the support-access and suspension actions, the field
 * grid, the Trust card (its heading, Change tier and its fields), tabs and the people list.
 */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the account">
      <PageHeaderSkeleton lead={false} />
      <Bone className="h-12 w-full max-w-prose rounded-lg" />
      <div className="flex flex-wrap gap-3">
        <Bone className="h-9 w-52 rounded-lg" />
        <Bone className="h-9 w-40 rounded-lg" />
      </div>
      <div className="grid gap-x-12 gap-y-7 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-3.5 w-20" />
            <Bone className="h-4 w-36" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-5 rounded-xl border p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <Bone className="h-6 w-20" />
            <Bone className="h-3.5 w-64 max-w-full" />
          </div>
          <Bone className="h-10 w-36 rounded-lg" />
        </div>
        <div className="grid gap-x-12 gap-y-7 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Bone className="h-3.5 w-24" />
              <Bone className="h-4 w-40" />
            </div>
          ))}
        </div>
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

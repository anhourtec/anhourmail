// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Invite codes: header, the new-code form (title, note, checkbox, plan and days, email and expiry, button), the list. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading invite codes">
      <PageHeaderSkeleton />
      <div className="flex max-w-2xl flex-col gap-4 rounded-xl border p-4">
        <Bone className="h-4 w-24" />
        <Bone className="h-10 w-full rounded-lg" />
        <Bone className="h-4 w-72" />
        <div className="flex gap-4">
          <Bone className="h-10 w-44 rounded-lg" />
          <Bone className="h-10 w-28 rounded-lg" />
        </div>
        <div className="flex gap-4">
          <Bone className="h-10 w-72 rounded-lg" />
          <Bone className="h-10 w-28 rounded-lg" />
        </div>
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
      <Bone className="mt-2 h-6 w-24" />
      <ListSkeleton rows={5} columns={4} />
    </SkeletonPage>
  );
}

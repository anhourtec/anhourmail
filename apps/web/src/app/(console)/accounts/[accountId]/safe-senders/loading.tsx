// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Safe senders: header, the section title and note, the add form (label, field, button, hint), the list. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading safe senders">
      <PageHeaderSkeleton />
      <Bone className="mt-2 h-6 w-56" />
      <Bone className="h-3.5 w-full max-w-[80ch]" />
      <Bone className="h-3.5 w-36" />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Bone className="h-10 w-full max-w-md rounded-lg" />
        <Bone className="h-10 w-24 rounded-lg" />
      </div>
      <Bone className="h-3 w-80" />
      <ListSkeleton rows={4} columns={2} />
    </SkeletonPage>
  );
}

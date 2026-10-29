// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Account settings: header, the export section (button, list, note), then the delete section and its form. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading account settings">
      <PageHeaderSkeleton />
      <Bone className="mt-2 h-6 w-48" />
      <Bone className="h-3.5 w-full max-w-[80ch]" />
      <Bone className="h-10 w-44 rounded-lg" />
      <ListSkeleton rows={2} columns={4} />
      <Bone className="h-3.5 w-80" />
      <Bone className="mt-4 h-6 w-40" />
      <Bone className="h-3.5 w-full max-w-[80ch]" />
      {[0, 1, 2, 3].map((i) => (
        <Bone key={i} className="h-3.5 w-full max-w-xl" />
      ))}
      <Bone className="h-10 w-full max-w-md rounded-lg" />
      <Bone className="h-10 w-44 rounded-lg" />
    </SkeletonPage>
  );
}

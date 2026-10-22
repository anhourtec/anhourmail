// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors App passwords: header, one mailbox (address, create button, app password rows), then the settings table. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading app passwords">
      <PageHeaderSkeleton />
      <Bone className="mt-2 h-6 w-64" />
      <Bone className="h-3.5 w-56" />
      <Bone className="h-10 w-48 rounded-lg" />
      <ListSkeleton rows={2} columns={2} />
      <Bone className="mt-4 h-6 w-56" />
      <ListSkeleton rows={5} columns={4} />
    </SkeletonPage>
  );
}

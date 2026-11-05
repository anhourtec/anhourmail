// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, CommandBarSkeleton, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Import mail: header, the command bar (new import, CSV batch), the imports list and the note below it. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading mail imports">
      <PageHeaderSkeleton />
      <CommandBarSkeleton actions={2} search={false} />
      <ListSkeleton rows={3} columns={4} />
      <Bone className="h-3.5 w-80" />
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage, TextBlockSkeleton } from "@anhourmail/ui/skeletons";

/** Mirrors a docs article: title, description, body text. The sidebar is part of the layout and stays. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[860px] px-4 py-8 md:px-8">
      <SkeletonPage label="Loading page">
        <Bone className="h-9 w-72 max-w-full" />
        <Bone className="h-4 w-96 max-w-full" />
        <TextBlockSkeleton lines={14} boxed={false} />
      </SkeletonPage>
    </div>
  );
}

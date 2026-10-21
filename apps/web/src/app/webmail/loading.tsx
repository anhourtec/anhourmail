// SPDX-License-Identifier: AGPL-3.0-only
import { FolderTreeSkeleton, MessageListSkeleton, ReaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <SkeletonPage label="Loading mail">
      <div className="grid min-h-dvh grid-cols-1 md:grid-cols-[220px_360px_1fr]">
        <div className="hidden border-r md:block">
          <FolderTreeSkeleton />
        </div>
        <div className="border-r">
          <MessageListSkeleton />
        </div>
        <div className="hidden md:block">
          <ReaderSkeleton />
        </div>
      </div>
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors Platform billing: header, the status line, three account lists (title, note, rows), the unmatched events. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading platform billing">
      <PageHeaderSkeleton />
      <Bone className="h-3.5 w-80" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <Bone className="mt-2 h-6 w-56" />
          <Bone className="h-3.5 w-full max-w-[80ch]" />
          <div className="flex max-w-3xl flex-col">
            {[0, 1].map((j) => (
              <div key={j} className="flex h-[46px] items-center justify-between border-b px-1">
                <Bone className="h-4 w-48" />
                <Bone className="h-4 w-28" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <Bone className="mt-2 h-6 w-48" />
      <ListSkeleton rows={3} columns={3} />
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

const ROWS = ["first", "second", "third"] as const;

export default function Loading() {
  return (
    <div className="am-site-section am-site-wrap">
      <SkeletonPage label="Loading credits">
        <Bone className="h-8 w-28 rounded-full" />
        <Bone className="h-12 w-64" />
        <Bone className="h-5 w-96 max-w-full" />
        {ROWS.map((key) => (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t py-6 sm:grid-cols-[10rem_1fr]">
            <Bone className="h-4 w-24" />
            <div className="flex flex-col gap-2">
              <Bone className="h-5 w-72 max-w-full" />
              <Bone className="h-4 w-full" />
            </div>
          </div>
        ))}
      </SkeletonPage>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

const CARDS = ["terms", "privacy", "aup"] as const;

export default function Loading() {
  return (
    <div className="am-site-wrap am-site-section pt-10">
      <SkeletonPage label="Loading legal pages">
        <Bone className="h-7 w-20 rounded-full" />
        <Bone className="h-12 w-96 max-w-full" />
        <Bone className="h-5 w-80 max-w-full" />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3">
          {CARDS.map((k) => (
            <Bone key={k} className="h-44 rounded-[20px]" />
          ))}
        </div>
      </SkeletonPage>
    </div>
  );
}

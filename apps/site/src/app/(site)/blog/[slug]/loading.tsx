// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

const LINES = ["a", "b", "c", "d", "e", "f", "g"] as const;

/** Mirrors a blog post: back link, title, date, lead, body. */
export default function Loading() {
  return (
    <div className="am-site-wrap am-site-section pt-10">
      <SkeletonPage label="Loading post">
        <Bone className="h-4 w-14" />
        <Bone className="h-12 w-[26rem] max-w-full" />
        <Bone className="h-4 w-48" />
        <Bone className="h-5 w-full" />
        {LINES.map((k) => (
          <Bone key={k} className="h-4 w-full" />
        ))}
      </SkeletonPage>
    </div>
  );
}

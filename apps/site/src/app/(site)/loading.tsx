// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors the hero: eyebrow chip, two-line title, lead, two buttons. */
export default function Loading() {
  return (
    <div className="am-site-section am-site-wrap">
      <SkeletonPage label="Loading">
        <Bone className="h-8 w-72 rounded-full" />
        <Bone className="h-14 w-[28rem] max-w-full" />
        <Bone className="h-14 w-80 max-w-full" />
        <Bone className="h-5 w-[30rem] max-w-full" />
        <div className="flex gap-3">
          <Bone className="h-[45px] w-40 rounded-lg" />
          <Bone className="h-[45px] w-36 rounded-lg" />
        </div>
      </SkeletonPage>
    </div>
  );
}

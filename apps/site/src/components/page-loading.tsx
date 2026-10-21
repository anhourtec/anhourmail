// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

const ROWS = ["a", "b", "c", "d"] as const;

/** Mirrors PageHero + a section: dark hero with title and lead, then a grid. */
export function PageLoading({ label }: { label: string }) {
  return (
    <SkeletonPage label={label}>
      <div className="am-site-hero am-site-under-nav flex flex-col items-center gap-5 px-5 pt-[150px] pb-24">
        <Bone className="h-12 w-[28rem] max-w-full opacity-30" />
        <Bone className="h-12 w-72 max-w-full opacity-30" />
        <Bone className="h-5 w-[30rem] max-w-full opacity-30" />
      </div>
      <div className="am-site-wrap-wide am-site-section grid grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {ROWS.map((k) => (
          <div key={k} className="flex flex-col gap-3">
            <Bone className="size-10 rounded-xl" />
            <Bone className="h-5 w-32" />
            <Bone className="h-4 w-full" />
          </div>
        ))}
      </div>
    </SkeletonPage>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

const LINES = ["a", "b", "c", "d", "e", "f"] as const;

/** Mirrors LegalPage: draft banner, contents column, title, date, sections. */
export function LegalLoading({ label }: { label: string }) {
  return (
    <div className="am-site-wrap-wide am-site-section pt-10">
      <SkeletonPage label={label}>
        <Bone className="h-14 w-full rounded-[18px]" />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="hidden flex-col gap-2 lg:flex">
            <Bone className="h-7 w-20 rounded-full" />
            {LINES.map((k) => (
              <Bone key={k} className="h-4 w-44" />
            ))}
          </div>
          <div className="flex max-w-[72ch] flex-col gap-4">
            <Bone className="h-12 w-80 max-w-full" />
            <Bone className="h-4 w-40" />
            <Bone className="h-5 w-full" />
            {LINES.map((k) => (
              <Bone key={k} className="h-4 w-full" />
            ))}
          </div>
        </div>
      </SkeletonPage>
    </div>
  );
}

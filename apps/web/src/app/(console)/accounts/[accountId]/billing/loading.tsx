// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/**
 * Mirrors Billing: header, the two tabs, "Overview" with the plan card (label, plan chip, the price, its note, the facts
 * row, the actions) beside the included card (feature list, two usage meters), then "Choose a paid plan" (two plan cards with their feature lists,
 * the options card and the summary card), and the payment card.
 */
export default function Loading() {
  const card = "rounded-2xl border p-5 sm:p-6";
  return (
    <SkeletonPage label="Loading billing">
      <PageHeaderSkeleton />
      <div className="flex gap-6 border-b pb-3">
        <Bone className="h-5 w-36" />
        <Bone className="h-5 w-16" />
      </div>
      <Bone className="mt-2 h-6 w-28" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`${card} flex flex-col gap-5`}>
          <div className="flex flex-col gap-2">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-6 w-20 rounded-full" />
            <Bone className="h-9 w-32" />
            <Bone className="h-3.5 w-64" />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Bone className="h-3.5 w-20" />
                <Bone className="h-4 w-28" />
              </div>
            ))}
          </div>
          <div className="flex gap-3 border-t pt-4">
            <Bone className="h-10 w-36 rounded-lg" />
          </div>
        </div>
        <div className={`${card} flex flex-col gap-5`}>
          <div className="flex justify-between">
            <Bone className="h-5 w-44" />
            <Bone className="h-3.5 w-16" />
          </div>
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Bone className="h-5 w-24" />
                <Bone className="h-1.5 w-full rounded-full" />
                <Bone className="h-3.5 w-32" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <Bone className="mt-2 h-6 w-48" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={`${card} flex flex-col gap-4`}>
            <div className="flex justify-between">
              <Bone className="h-7 w-28" />
              <Bone className="h-6 w-24 rounded-full" />
            </div>
            <Bone className="h-3.5 w-full" />
            <Bone className="h-9 w-28" />
            <div className="flex flex-col gap-2.5 border-t pt-4">
              {[0, 1, 2, 3, 4].map((j) => (
                <Bone key={j} className="h-4 w-56" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className={`${card} flex flex-col gap-4`}>
          <Bone className="h-10 w-32 rounded-lg" />
          <Bone className="h-10 w-48 rounded-lg" />
          <Bone className="h-10 w-48 rounded-lg" />
        </div>
        <div className={`${card} flex flex-col gap-3`}>
          <Bone className="h-4 w-24" />
          <Bone className="h-4 w-full" />
          <Bone className="h-6 w-full" />
          <Bone className="h-10 w-full rounded-lg" />
        </div>
      </div>
      <Bone className="h-24 w-full rounded-2xl" />
    </SkeletonPage>
  );
}

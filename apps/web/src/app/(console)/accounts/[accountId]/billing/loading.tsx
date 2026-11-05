// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/**
 * Mirrors Billing: header, "Your plan" (title, the four fields in two columns, the state note, the action buttons),
 * "What the account uses" (four rows), then "Choose a paid plan" (two plan cards, the currency field, two steppers, the
 * total and the button).
 */
export default function Loading() {
  return (
    <SkeletonPage label="Loading billing">
      <PageHeaderSkeleton />
      <Bone className="mt-2 h-6 w-32" />
      <div className="grid gap-x-12 gap-y-7 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-4 w-44" />
          </div>
        ))}
      </div>
      <Bone className="h-12 w-full max-w-[80ch] rounded-lg" />
      <div className="flex flex-wrap gap-3">
        <Bone className="h-10 w-56 rounded-lg" />
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
      <Bone className="mt-2 h-6 w-56" />
      <div className="flex max-w-xl flex-col">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex h-[46px] items-center justify-between border-b px-1">
            <Bone className="h-4 w-40" />
            <Bone className="h-4 w-16" />
          </div>
        ))}
      </div>
      <Bone className="mt-2 h-6 w-48" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Bone className="h-28 rounded-xl" />
        <Bone className="h-28 rounded-xl" />
      </div>
      <Bone className="h-10 w-32 rounded-lg" />
      <div className="flex flex-col gap-3">
        <Bone className="h-10 w-48 rounded-lg" />
        <Bone className="h-10 w-48 rounded-lg" />
      </div>
      <Bone className="h-16 w-full rounded-xl" />
      <Bone className="h-10 w-48 rounded-lg" />
    </SkeletonPage>
  );
}

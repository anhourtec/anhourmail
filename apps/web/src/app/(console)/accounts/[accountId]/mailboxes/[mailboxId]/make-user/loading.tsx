// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, FormSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors "Make this a user" (the "Add a user" steps): header, the step indicator (top on narrow screens, a vertical stepper on wide) and the form. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the make-this-a-user form">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <div className="flex flex-col gap-2 lg:hidden">
          <Bone className="h-3.5 w-40" />
          <Bone className="h-1 w-full rounded-full" />
        </div>
        <div className="hidden flex-col gap-2 lg:flex">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2.5 py-2">
              <Bone className="size-6 rounded-full" />
              <Bone className="h-3.5 w-28" />
            </div>
          ))}
        </div>
        <div className="flex max-w-2xl flex-col gap-5">
          <Bone className="h-7 w-32" />
          <Bone className="h-3.5 w-80 max-w-full" />
          <FormSkeleton fields={5} />
        </div>
      </div>
    </SkeletonPage>
  );
}

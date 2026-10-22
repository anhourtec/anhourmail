// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

export default function Loading() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <main className="flex flex-col gap-6 px-4 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <Bone className="h-4 w-28" />
          <Bone className="size-9 rounded-lg" />
        </div>
        <Bone className="h-[4.25rem] w-full rounded-2xl lg:hidden" />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 pb-12 lg:py-12">
          <SkeletonPage label="Loading forwarding confirmation">
            <Bone className="h-3 w-20" />
            <Bone className="h-8 w-56" />
            <Bone className="h-4 w-72 max-w-full" />
            <Bone className="h-10 w-full rounded-lg" />
            <Bone className="h-10 w-full rounded-lg" />
            <Bone className="h-10 w-full rounded-lg" />
          </SkeletonPage>
        </div>
      </main>
      <aside className="hidden p-3 lg:block">
        <Bone className="h-full w-full rounded-2xl" />
      </aside>
    </div>
  );
}

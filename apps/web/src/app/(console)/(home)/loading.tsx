// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, ListSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/**
 * Mirrors the console frame and the home page: the 48 px navy app bar (wordmark, centred search, avatar), the
 * left navigation (wide screens), then quick actions, the greeting, cards, the account's storage and the account tabs.
 */
export default function Loading() {
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <div className="flex h-12 items-center gap-3 border-b border-appbar-border bg-appbar px-3">
        <span className="h-3.5 w-28 rounded bg-appbar-accent" />
        <span className="mx-auto hidden h-8 w-full max-w-[30rem] rounded-md bg-appbar-accent md:block" />
        <span className="ml-auto size-8 rounded-full bg-appbar-accent md:ml-0" />
      </div>
      <div className="flex flex-1">
        <div className="hidden w-60 shrink-0 flex-col gap-0.5 border-r bg-sidebar px-2 lg:flex">
          <div className="flex h-12 items-center px-4">
            <Bone className="size-5 rounded" />
          </div>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex h-10 items-center gap-3 px-4">
              <Bone className="size-5 rounded" />
              <Bone className="h-3.5 w-28" />
            </div>
          ))}
        </div>
        <main className="flex-1 px-4 pt-5 pb-10 sm:px-6 lg:px-10 lg:pt-6">
          <SkeletonPage label="Loading console">
            <Bone className="h-12 w-full rounded-lg" />
            <div className="flex flex-col gap-2.5">
              <Bone className="h-9 w-80 max-w-full" />
              <Bone className="h-3.5 w-96 max-w-full" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Bone className="h-28 w-full rounded-lg" />
              <Bone className="h-28 w-full rounded-lg" />
            </div>
            <div className="flex flex-col gap-3">
              <Bone className="h-7 w-40" />
              <div className="flex max-w-md flex-col gap-2">
                <Bone className="h-3.5 w-72 max-w-full" />
                <Bone className="h-1.5 w-full rounded-full" />
              </div>
              <div className="flex gap-5 border-b pb-2">
                <Bone className="h-4 w-24" />
                <Bone className="h-4 w-20" />
                <Bone className="h-4 w-20" />
              </div>
              <ListSkeleton rows={4} columns={2} />
            </div>
          </SkeletonPage>
        </main>
      </div>
    </div>
  );
}

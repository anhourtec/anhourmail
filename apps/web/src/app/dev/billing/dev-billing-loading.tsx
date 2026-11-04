// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

/** The dev billing pages' skeleton: a heading, a facts card and a row of buttons. */
export function DevBillingLoading({ label }: { label: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-10">
      <SkeletonPage label={label}>
        <Bone className="h-3 w-56" />
        <Bone className="h-8 w-48" />
        <Bone className="h-40 w-full rounded-xl" />
        <div className="flex flex-wrap gap-2">
          <Bone className="h-10 w-28 rounded-lg" />
          <Bone className="h-10 w-36 rounded-lg" />
          <Bone className="h-10 w-32 rounded-lg" />
        </div>
      </SkeletonPage>
    </main>
  );
}

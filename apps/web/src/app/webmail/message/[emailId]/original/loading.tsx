// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors the Show original page: title, summary table, two actions, source block. */
export default function Loading() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <SkeletonPage label="Loading the original message">
        <Bone className="h-9 w-64" />
        <div className="rounded-xl border px-4">
          {["w-72", "w-80", "w-56", "w-60", "w-96", "w-44", "w-48", "w-40"].map((w, i) => (
            <div
              key={`${w}-${String(i)}`}
              className="grid grid-cols-1 gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
            >
              <Bone className="h-3.5 w-20" />
              <Bone className={`h-3.5 max-w-full ${w}`} />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Bone className="h-10 w-44 rounded-lg" />
          <Bone className="h-10 w-44 rounded-lg" />
        </div>
        <Bone className="h-[50vh] w-full rounded-xl" />
      </SkeletonPage>
    </main>
  );
}

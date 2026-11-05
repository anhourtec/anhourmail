// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, PageHeaderSkeleton, SkeletonPage, TextBlockSkeleton } from "@anhourmail/ui/skeletons";

/** Mirrors Import many mailboxes: header, the three steps, the template button, the upload box and the guide link. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the batch import form">
      <PageHeaderSkeleton />
      <TextBlockSkeleton lines={3} boxed={false} />
      <Bone className="h-10 w-48 rounded-lg" />
      <div className="flex max-w-xl flex-col gap-3 rounded-xl border p-4">
        <Bone className="h-5 w-48" />
        <Bone className="h-9 w-64 rounded-lg" />
        <Bone className="h-3 w-80" />
        <Bone className="h-10 w-44 rounded-lg" />
      </div>
      <Bone className="h-3.5 w-72" />
    </SkeletonPage>
  );
}

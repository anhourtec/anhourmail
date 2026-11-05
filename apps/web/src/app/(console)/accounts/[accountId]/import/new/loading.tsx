// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, FormSkeleton, PageHeaderSkeleton, SkeletonPage } from "@anhourmail/ui/skeletons";

/** Mirrors New import: header, then the form (mailbox, provider, server, sign-in, options) and its button. */
export default function Loading() {
  return (
    <SkeletonPage label="Loading the new import form">
      <PageHeaderSkeleton />
      <div className="flex max-w-xl flex-col gap-6">
        <FormSkeleton fields={2} button={false} />
        <FormSkeleton fields={3} button={false} />
        <Bone className="h-4 w-64" />
        <Bone className="h-4 w-72" />
        <Bone className="h-4 w-56" />
        <Bone className="h-10 w-36 rounded-lg" />
      </div>
    </SkeletonPage>
  );
}

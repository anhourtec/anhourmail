// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, FolderTreeSkeleton, MessageListSkeleton, ReaderSkeleton } from "@anhourmail/ui/skeletons";

/** Mirrors WebmailApp: sidebar (wide screens) · list with header and search · reader (from md up). */
export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[23rem_minmax(0,1fr)] lg:grid-cols-[15rem_26rem_minmax(0,1fr)]"
    >
      <span className="sr-only">Loading mail</span>
      <div className="hidden min-h-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex flex-col gap-3 px-3 pt-3 pb-2">
          <div className="flex gap-1.5">
            <Bone className="size-8 rounded-md" />
            <Bone className="size-8 rounded-md" />
          </div>
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Bone className="h-3.5 w-24" />
            <Bone className="h-3 w-40" />
          </div>
          <Bone className="h-9 w-full rounded-lg" />
        </div>
        <div className="flex-1 px-2">
          <FolderTreeSkeleton folders={8} />
        </div>
        <div className="flex flex-col gap-2 border-t p-3">
          <Bone className="h-4 w-32" />
          <Bone className="h-4 w-36" />
        </div>
      </div>
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex h-14 items-center gap-3 px-3">
          <Bone className="size-8 rounded-lg" />
          <Bone className="h-6 w-24" />
        </div>
        <div className="px-2 pb-2">
          <Bone className="h-8 w-full rounded-lg" />
        </div>
        <div className="overflow-hidden border-t">
          <MessageListSkeleton rows={8} />
        </div>
      </div>
      <div className="hidden min-h-0 flex-col md:flex">
        <div className="h-14 border-b" />
        <ReaderSkeleton />
      </div>
    </div>
  );
}

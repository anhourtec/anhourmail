// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, FolderTreeSkeleton, MessageListSkeleton, ReaderSkeleton } from "@anhourmail/ui/skeletons";

/** Mirrors WebmailApp: folders (wide screens) · list with its header · reader (from md up). */
export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[22rem_minmax(0,1fr)] lg:grid-cols-[15rem_24rem_minmax(0,1fr)]"
    >
      <span className="sr-only">Loading mail</span>
      <div className="hidden min-h-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center px-4">
          <Bone className="h-4 w-36" />
        </div>
        <div className="flex-1 px-2">
          <FolderTreeSkeleton folders={8} />
        </div>
        <div className="flex flex-col gap-3 border-t p-3">
          <Bone className="h-4 w-44" />
          <Bone className="h-9 w-[6.5rem] rounded-lg" />
        </div>
      </div>
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Bone className="h-5 w-24" />
          <Bone className="h-3 w-16" />
        </div>
        <div className="overflow-hidden">
          <MessageListSkeleton rows={10} />
        </div>
      </div>
      <div className="hidden min-h-0 flex-col md:flex">
        <div className="h-14 border-b" />
        <ReaderSkeleton />
      </div>
    </div>
  );
}

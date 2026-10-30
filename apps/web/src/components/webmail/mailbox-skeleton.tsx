// SPDX-License-Identifier: AGPL-3.0-only
import { Bone, FolderTreeSkeleton, MessageListSkeleton, ReaderSkeleton } from "@anhourmail/ui/skeletons";

/**
 * Mirrors a mailbox shared with the person while it opens (ADR-0026 §6): the banner naming it, then the webmail's
 * sidebar (wide screens; no New email, no Contacts), the list with its header and search, and the reader (from md up).
 */
export function SharedMailboxSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex h-dvh flex-col overflow-hidden">
      <span className="sr-only">Opening the mailbox</span>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b bg-accent px-4">
        <Bone className="size-4 rounded" />
        <Bone className="h-3.5 w-64 max-w-[50%]" />
        <div className="flex-1" />
        <Bone className="h-8 w-28 rounded-lg sm:w-40" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[23rem_minmax(0,1fr)] lg:grid-cols-[15rem_26rem_minmax(0,1fr)]">
        <div className="hidden min-h-0 flex-col border-r bg-sidebar lg:flex">
          <div className="flex flex-col gap-3 px-3 pt-3 pb-2">
            <div className="flex gap-1.5">
              <Bone className="size-8 rounded-md" />
            </div>
            <div className="flex flex-col gap-1.5 border-t pt-3">
              <Bone className="h-2.5 w-20" />
              <Bone className="h-3.5 w-24" />
              <Bone className="h-3 w-40" />
            </div>
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
    </div>
  );
}

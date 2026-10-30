// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { type Actor, ForbiddenError, NotFoundError } from "@anhourmail/core";
import { type DelegationAvailability, getMailboxDelegation } from "@anhourmail/core/delegation";

import { container } from "@/server/container";

import { type DelegatePerson, DelegationTab, type DelegationReadOnly } from "./delegation-tab";

/**
 * Loads a mailbox's Delegation tab on the server (streamed in behind `DelegationTabSkeleton`): the three lists and
 * whether this viewer may change them here (`availability`: the plan and the viewer's role, read by the page). `people`
 * are the account's people when the page has them (for the picker); the mailbox's own person is never offered.
 */
export async function DelegationSection({
  actor,
  accountId,
  mailboxId,
  ownerUserId,
  deleting,
  availability,
  people,
  photos,
}: {
  actor: Actor;
  accountId: string;
  mailboxId: string;
  ownerUserId: string | null;
  deleting: boolean;
  availability: DelegationAvailability;
  people: DelegatePerson[] | null;
  photos: Record<string, string>;
}) {
  const deps = container().deps;
  const view = await getMailboxDelegation(deps, actor, accountId, mailboxId).catch((err: unknown) => {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) return null;
    throw err;
  });
  if (!view) {
    return (
      <p className="am-body">Your role in this account doesn&apos;t include seeing who has access to mailboxes.</p>
    );
  }
  // The role and the Owner-only rule come first: "plan" is the one read-only state that still lets this viewer remove
  // access (after a downgrade), so it applies only to someone who may manage this mailbox.
  const readOnly: DelegationReadOnly = !availability.canManage
    ? { kind: "role" }
    : !view.canManage
      ? { kind: "locked" }
      : !availability.plan
        ? { kind: "plan", planName: availability.planName }
        : deleting
          ? { kind: "deleting" }
          : null;
  return (
    <DelegationTab
      // A server refresh with different lists starts the tab again from them.
      key={[view.fullAccess, view.sendAs, view.sendOnBehalf].map((l) => l.map((p) => p.userId).join(",")).join("|")}
      accountId={accountId}
      mailboxId={mailboxId}
      address={view.address}
      initial={{ fullAccess: view.fullAccess, sendAs: view.sendAs, sendOnBehalf: view.sendOnBehalf }}
      candidates={readOnly === null ? (people ?? []).filter((p) => p.userId !== ownerUserId) : []}
      photos={photos}
      readOnly={readOnly}
    />
  );
}

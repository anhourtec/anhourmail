// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { avatarPath, ownAvatar } from "@anhourmail/core/avatars";
import { getOwnProfile } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { initialsOf } from "@/components/console/initials";
import { CopyValue } from "@/components/copy-value";
import { EditPersonName } from "@/components/people/edit-person-name";
import { EditProfile } from "@/components/people/edit-profile";
import { ProfilePhoto } from "@/components/people/profile-photo";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Profile" };

/**
 * The signed-in person's Profile: their name, photo and console sign-in, and the optional profile details (job title …
 * country) they can edit themselves (`self.profile.manage`). Admins of their accounts see the same details on the
 * People page. The photo is the one the console app bar, the People page and the webmail of their mailboxes show
 * (ADR-0022). The name is the one source (rule 61): it is also the sender name of their mailboxes unless an admin gave
 * one a custom display name, which this page says.
 */
export default async function ProfilePage() {
  const actor = await requireUser();
  const [profile, photo] = await Promise.all([
    getOwnProfile(container().deps, actor),
    ownAvatar(container().deps, actor),
  ]);
  return (
    <>
      <PageHeader
        title="Profile"
        description="Optional details about you, for the people who run your accounts. Only they and you can see them."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Profile" }]}
      />
      <section aria-labelledby="profile-who" className="flex flex-col gap-3">
        <h2 id="profile-who" className="am-h3">
          {actor.name ?? actor.email}
        </h2>
        {profile.canEdit ? (
          <ProfilePhoto
            url={photo ? avatarPath("/api/avatars", photo) : null}
            initials={initialsOf(actor.name !== undefined && actor.name !== "" ? actor.name : actor.email)}
            endpoint="/api/me/avatar"
            subject="your photo"
          />
        ) : null}
        <EditPersonName url="/api/me/profile" name={actor.name ?? ""} canEdit={profile.canEdit} />
        <p className="am-small max-w-prose">
          Your name and photo are what the people in your accounts see, here and in the webmail of your mailboxes. Your
          name is also the sender name on mail from your mailboxes, unless an admin set a different display name for one
          of them.
        </p>
        <div className="flex flex-col gap-1">
          <span className="am-small">Email (console sign-in)</span>
          <CopyValue value={actor.email} label="email" />
        </div>
      </section>
      <section aria-labelledby="profile-details" className="flex flex-col gap-4">
        <h2 id="profile-details" className="am-h3">
          Profile details
        </h2>
        <EditProfile url="/api/me/profile" details={profile.details} canEdit={profile.canEdit} />
      </section>
    </>
  );
}

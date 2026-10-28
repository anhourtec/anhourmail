// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { getOwnProfile } from "@anhourmail/core/people";
import { PageHeader } from "@anhourmail/ui/page-header";

import { CopyValue } from "@/components/copy-value";
import { EditProfile } from "@/components/people/edit-profile";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Profile" };

/**
 * The signed-in person's Profile: their name and console sign-in, and the optional profile details (job title …
 * country) they can edit themselves (`self.profile.manage`). Admins of their accounts see the same details on the
 * People page.
 */
export default async function ProfilePage() {
  const actor = await requireUser();
  const profile = await getOwnProfile(container().deps, actor);
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

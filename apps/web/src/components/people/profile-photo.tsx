// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRouter } from "next/navigation";

import { PhotoEditor } from "../photo-editor";
import { secondaryButtonClass } from "../ui-classes";

/**
 * A profile photo control in the console (the Profile page, a person's or a shared mailbox's panel). After a change
 * the page's server parts re-render, so the app bar, the person menu and every list on the page show the new photo at
 * once (rule 61); the webmail picks it up when its tab is next shown.
 */
export function ProfilePhoto({
  url,
  initials,
  endpoint,
  subject,
}: {
  url: string | null;
  initials: string;
  endpoint: string;
  subject: string;
}) {
  const router = useRouter();
  return (
    <PhotoEditor
      url={url}
      initials={initials}
      endpoint={endpoint}
      subject={subject}
      onChanged={() => {
        router.refresh();
      }}
      previewClass="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary/12 font-display text-[22px] font-medium text-primary sm:size-20 sm:text-[26px]"
      buttonClass={secondaryButtonClass}
    />
  );
}

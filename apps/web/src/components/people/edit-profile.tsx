// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { callApi } from "../api";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { cleanProfile, ProfileFieldsGrid, profileErrors, ProfileSummary, type ProfileValues } from "./profile-fields";

/**
 * "Edit profile": the optional profile details (job title … country) as a list, and for people who may change them
 * (the person themself; an admin for a Member; an Owner for anyone) an inline form that replaces them all — an emptied
 * field is cleared. `url` is the person's profile endpoint (`/api/me/profile` or the People route).
 */
export function EditProfile({ url, details, canEdit }: { url: string; details: ProfileValues; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState<ProfileValues>(details);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: SyntheticEvent) {
    e.preventDefault();
    const found = profileErrors(profile);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    setError(null);
    const res = await callApi(url, { method: "PUT", body: { profile: cleanProfile(profile) } });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setEditing(false);
    setSaved(true);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        <ProfileSummary profile={details} />
        {saved && (
          <p role="status" className="am-small">
            Profile saved.
          </p>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setProfile(details);
              setErrors({});
              setError(null);
              setSaved(false);
              setEditing(true);
            }}
            className={`${secondaryButtonClass} w-fit`}
          >
            <Pencil className="size-4" aria-hidden />
            Edit profile
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-2xl flex-col gap-5" noValidate>
      <ProfileFieldsGrid profile={profile} onChange={setProfile} errors={errors} />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Saving…" : "Save profile"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
          }}
          className={secondaryButtonClass}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

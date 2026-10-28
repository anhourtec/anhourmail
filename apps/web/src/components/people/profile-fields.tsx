// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { nameProblem } from "@anhourmail/shared/names";
import {
  COUNTRIES,
  countryName,
  PHONE_PATTERN,
  PROFILE_FIELD_INFO,
  PROFILE_FIELDS,
  type ProfileField,
} from "@anhourmail/shared/profile";

import { inputClass } from "../ui-classes";

export type ProfileValues = Partial<Record<ProfileField, string>>;

/** The browser's check of the optional profile details (the server checks them again): field → message. */
export function profileErrors(profile: ProfileValues): Partial<Record<ProfileField, string>> {
  const e: Partial<Record<ProfileField, string>> = {};
  for (const f of PROFILE_FIELDS) {
    const v = (profile[f] ?? "").trim();
    if (v === "") continue;
    const { label, max } = PROFILE_FIELD_INFO[f];
    if (v.length > max) e[f] = `${label} is too long.`;
    else if ((f === "officePhone" || f === "mobilePhone") && !PHONE_PATTERN.test(v)) {
      e[f] = "Use digits, spaces and + ( ) - only.";
    } else if (f !== "country" && f !== "officePhone" && f !== "mobilePhone" && nameProblem(v)) {
      e[f] = nameProblem(v) ?? "";
    }
  }
  return e;
}

/** Trimmed values with the empty ones left out, as the API takes them. */
export function cleanProfile(profile: ProfileValues): Record<string, string> {
  return Object.fromEntries(
    Object.entries(profile)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ""),
  );
}

/**
 * The optional profile fields (job title … country) as a two-column grid of inputs, used by "Add a user", "Make this
 * a user" and "Edit profile".
 */
export function ProfileFieldsGrid({
  profile,
  onChange,
  errors,
}: {
  profile: ProfileValues;
  onChange: (next: ProfileValues) => void;
  errors: Partial<Record<string, string>>;
}) {
  const error = (f: ProfileField) =>
    errors[f] ? (
      <span id={`err-${f}`} className="am-micro text-destructive">
        {errors[f]}
      </span>
    ) : null;
  const describedBy = (f: ProfileField) => (errors[f] ? { "aria-describedby": `err-${f}`, "aria-invalid": true } : {});
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {PROFILE_FIELDS.filter((f) => f !== "country").map((f) => (
        <label key={f} className="flex flex-col gap-1.5">
          <span className="am-h4">{PROFILE_FIELD_INFO[f].label}</span>
          <input
            value={profile[f] ?? ""}
            onChange={(e) => {
              onChange({ ...profile, [f]: e.target.value });
            }}
            type={f === "officePhone" || f === "mobilePhone" ? "tel" : "text"}
            autoComplete="off"
            maxLength={PROFILE_FIELD_INFO[f].max}
            className={inputClass}
            {...describedBy(f)}
          />
          {error(f)}
        </label>
      ))}
      <label className="flex flex-col gap-1.5">
        <span className="am-h4">{PROFILE_FIELD_INFO.country.label}</span>
        <select
          value={profile.country ?? ""}
          onChange={(e) => {
            onChange({ ...profile, country: e.target.value });
          }}
          className={inputClass}
        >
          <option value="">Not set</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        {error("country")}
      </label>
    </div>
  );
}

/** The given profile details as a label / value list ("None given." when empty). */
export function ProfileSummary({ profile }: { profile: ProfileValues }) {
  const given = PROFILE_FIELDS.filter((f) => (profile[f] ?? "").trim() !== "");
  if (given.length === 0) return <p className="am-small">None given.</p>;
  return (
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
      {given.map((f) => (
        <div key={f} className="contents">
          <dt className="am-small">{PROFILE_FIELD_INFO[f].label}</dt>
          <dd className="am-body break-words">
            {f === "country" ? (countryName(profile[f] ?? "") ?? profile[f]) : profile[f]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

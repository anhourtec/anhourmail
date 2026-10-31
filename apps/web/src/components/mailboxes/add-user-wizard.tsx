// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, UserPlus } from "lucide-react";
import Link from "next/link";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";

import { DELEGATION_RIGHT_LABELS, type DelegationRight } from "@anhourmail/shared/delegation";
import { nameProblem } from "@anhourmail/shared/names";
import { ACCOUNT_ROLE_SUMMARIES, type AccountRole, ROLE_LABELS } from "@anhourmail/shared/rbac";
import { mailboxPasswordProblem } from "@anhourmail/shared/security";

import { callApi } from "../api";
import {
  cleanProfile,
  ProfileFieldsGrid,
  profileErrors,
  ProfileSummary,
  type ProfileValues,
} from "../people/profile-fields";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { MailboxPasswordField } from "./mailbox-password-field";

export type AddUserOptions = {
  domains: { id: string; name: string; free: boolean }[];
  /** Whole GB unassigned in the account's pool, and the default share for a new mailbox. */
  maxQuotaGb: number;
  defaultQuotaGb: number;
  /** Roles this admin may give (an Owner any, a User Administrator Member only). */
  roles: AccountRole[];
};

type StepId = "basics" | "role" | "profile" | "review";
const STEPS: { id: StepId; label: string }[] = [
  { id: "basics", label: "Basics" },
  { id: "role", label: "Role" },
  { id: "profile", label: "Optional settings" },
  { id: "review", label: "Review and finish" },
];

type Added = { address: string; password: string | null; requirePasswordChange: boolean };

/**
 * "Make this a user": the person-less mailbox the person will sign in with (no new mailbox is created), and the people
 * who already have access to it through delegation (listed before Finish; null when the viewer can't see them).
 */
export type ExistingMailbox = {
  mailboxId: string;
  address: string;
  displayName: string | null;
  delegates?: { userId: string; name: string; email: string; rights: DelegationRight[] }[] | null;
};

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * "Add a user" as a four-step page: Basics (names, address, storage, password), Role, Optional settings (profile
 * details) and Review. Each step is checked before Next; the server checks everything again on Finish
 * (`POST /api/accounts/:accountId/users`). Steps already visited can be reopened from the stepper. The done screen
 * shows a generated password once, with Copy, and where to sign in.
 *
 * With `existing` it is "Make this a user" for a person-less mailbox: the same Basics (names only; the address is the
 * mailbox's), Role and Optional settings, then `POST /api/accounts/:accountId/mailboxes/:mailboxId/user`, which always
 * generates a new password with the first-sign-in change, and asks the admin to confirm it's them (step-up) first.
 */
export function AddUserWizard({
  accountId,
  options,
  webmailUrl,
  consoleUrl,
  existing,
}: {
  accountId: string;
  options: AddUserOptions;
  webmailUrl: string;
  consoleUrl: string;
  existing?: ExistingMailbox;
}) {
  const [step, setStep] = useState<StepId>("basics");
  const [visited, setVisited] = useState<Set<StepId>>(new Set(["basics"]));
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [displayEdited, setDisplayEdited] = useState(Boolean(existing?.displayName));
  const [localPart, setLocalPart] = useState("");
  const [domainId, setDomainId] = useState(options.domains[0]?.id ?? "");
  const [quotaGb, setQuotaGb] = useState(String(options.defaultQuotaGb || ""));
  const [autoPassword, setAutoPassword] = useState(true);
  const [password, setPassword] = useState("");
  const [requireChange, setRequireChange] = useState(true);
  const [role, setRole] = useState<AccountRole>(
    options.roles.includes("member") ? "member" : (options.roles[0] ?? "member"),
  );
  const [profile, setProfile] = useState<ProfileValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const uid = useId();

  const domain = options.domains.find((d) => d.id === domainId);
  const address = existing ? existing.address : `${localPart.trim().toLowerCase()}@${domain?.name ?? ""}`;
  const index = STEPS.findIndex((s) => s.id === step);

  const names = (first: string, last: string) => [first.trim(), last.trim()].filter(Boolean).join(" ");

  function check(id: StepId): Record<string, string> {
    const e: Record<string, string> = {};
    if (id === "basics") {
      if (firstName.trim() === "") e.firstName = "Enter a first name.";
      else if (nameProblem(firstName.trim())) e.firstName = nameProblem(firstName.trim()) ?? "";
      if (lastName.trim() !== "" && nameProblem(lastName.trim())) e.lastName = nameProblem(lastName.trim()) ?? "";
      if (displayName.trim() === "") e.displayName = "Enter a display name.";
      else if (displayName.trim().length > 80) e.displayName = "Use at most 80 characters.";
      else if (nameProblem(displayName.trim())) e.displayName = nameProblem(displayName.trim()) ?? "";
      if (existing) return e;
      if (!LOCAL_PART.test(localPart.trim().toLowerCase()) || localPart.includes("..")) {
        e.localPart = "Use letters, numbers, dots, hyphens or underscores, like jane.doe.";
      }
      if (!domain) e.localPart = "Choose a domain.";
      const gb = Number(quotaGb);
      if (!Number.isInteger(gb) || gb < 1 || gb > options.maxQuotaGb) {
        e.quotaGb = `Choose a whole number of GB from 1 to ${String(options.maxQuotaGb)}.`;
      }
      if (!autoPassword) {
        const problem = password === "" ? "Choose a password." : mailboxPasswordProblem(password, address);
        if (problem) e.password = problem;
      }
    }
    if (id === "role" && !options.roles.includes(role)) e.role = "Choose a role.";
    if (id === "profile") Object.assign(e, profileErrors(profile));
    return e;
  }

  function go(next: StepId) {
    setErrors({});
    setSubmitError(null);
    setStep(next);
    setVisited((v) => new Set(v).add(next));
  }

  function onNext(e: SyntheticEvent) {
    e.preventDefault();
    const found = check(step);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const next = STEPS[index + 1];
    if (next) go(next.id);
  }

  async function finish() {
    for (const s of ["basics", "role", "profile"] as const) {
      const found = check(s);
      if (Object.keys(found).length > 0) {
        go(s);
        setErrors(found);
        return;
      }
    }
    setPending(true);
    setSubmitError(null);
    const cleaned = cleanProfile(profile);
    if (existing) {
      const made = await callApi(
        `/api/accounts/${encodeURIComponent(accountId)}/mailboxes/${encodeURIComponent(existing.mailboxId)}/user`,
        {
          method: "POST",
          body: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            displayName: displayName.trim(),
            role,
            profile: cleaned,
          },
        },
      );
      setPending(false);
      if (!made.ok) {
        if (made.code === "step_up_required") setStepUp(true);
        else setSubmitError(made.message);
        return;
      }
      setStepUp(false);
      const data = made.data as { password?: string } | undefined;
      setAdded({
        address: existing.address,
        password: typeof data?.password === "string" ? data.password : null,
        requirePasswordChange: true,
      });
      return;
    }
    const res = await callApi(`/api/accounts/${accountId}/users`, {
      method: "POST",
      body: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        displayName: displayName.trim(),
        localPart: localPart.trim(),
        domainId,
        role,
        quotaGb: Number(quotaGb),
        generatePassword: autoPassword,
        ...(autoPassword ? {} : { password }),
        requirePasswordChange: requireChange,
        profile: cleaned,
      },
    });
    setPending(false);
    if (!res.ok) {
      setSubmitError(res.message);
      return;
    }
    const data = res.data as { mailbox?: { address?: string }; password?: string | null } | undefined;
    setPassword("");
    setAdded({
      address: data?.mailbox?.address ?? address,
      password: typeof data?.password === "string" ? data.password : null,
      requirePasswordChange: requireChange,
    });
  }

  if (added) {
    return (
      <Done
        added={added}
        made={existing !== undefined}
        accountId={accountId}
        webmailUrl={webmailUrl}
        consoleUrl={consoleUrl}
        onAnother={() => {
          setAdded(null);
          setFirstName("");
          setLastName("");
          setDisplayName("");
          setDisplayEdited(false);
          setLocalPart("");
          setProfile({});
          setAutoPassword(true);
          setRequireChange(true);
          setVisited(new Set(["basics"]));
          setStep("basics");
        }}
      />
    );
  }

  const fieldError = (k: string) =>
    errors[k] ? (
      <span id={`${uid}-err-${k}`} className="am-micro text-destructive">
        {errors[k]}
      </span>
    ) : null;
  /**
   * The input's id (its `Field` label points at it) and its description: the field's hint and note, then its error.
   * The label stays the accessible name on its own ("Last name", never "Last nameOptional").
   */
  const describedBy = (k: string, extra: string[] = []) => {
    const ids = [...(FIELD_HINTS[k] ? [`${uid}-hint-${k}`] : []), ...extra, ...(errors[k] ? [`${uid}-err-${k}`] : [])];
    return {
      id: `${uid}-f-${k}`,
      ...(ids.length > 0 ? { "aria-describedby": ids.join(" ") } : {}),
      ...(errors[k] ? { "aria-invalid": true } : {}),
    };
  };
  const field = (k: string) => ({ uid, name: k, hint: FIELD_HINTS[k], error: fieldError(k) });

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
      {/* Top indicator at narrow widths; vertical stepper from lg up. */}
      <div className="flex flex-col gap-2 lg:hidden">
        <p className="am-small">
          Step <span className="am-num">{index + 1}</span> of <span className="am-num">{STEPS.length}</span>:{" "}
          <span className="text-foreground">{STEPS[index]?.label}</span>
        </p>
        <div className="flex gap-1.5" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s.id} className={`h-1 flex-1 rounded-full ${i <= index ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
      </div>
      <nav aria-label="Steps" className="hidden lg:block">
        <ol className="flex flex-col gap-1">
          {STEPS.map((s, i) => {
            const current = s.id === step;
            const reachable = visited.has(s.id) && !current;
            const done = visited.has(s.id) && i < index;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={current ? "step" : undefined}
                  onClick={() => {
                    go(s.id);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors ${
                    current ? "bg-accent text-foreground" : reachable ? "hover:bg-accent" : "text-muted-foreground"
                  }`}
                >
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] ${
                      current || done ? "border-primary bg-primary text-primary-foreground" : ""
                    }`}
                  >
                    {done ? <Check className="size-3.5" aria-hidden /> : <span className="am-num">{i + 1}</span>}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <form onSubmit={onNext} className="flex max-w-2xl flex-col gap-6" noValidate>
        {step === "basics" && (
          <Section title="Basics" lead="Who this user is, their address and how they first sign in.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" {...field("firstName")}>
                <input
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                    if (!displayEdited) setDisplayName(names(e.target.value, lastName));
                  }}
                  autoComplete="off"
                  maxLength={60}
                  className={inputClass}
                  {...describedBy("firstName")}
                />
              </Field>
              <Field label="Last name" {...field("lastName")}>
                <input
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                    if (!displayEdited) setDisplayName(names(firstName, e.target.value));
                  }}
                  autoComplete="off"
                  maxLength={60}
                  className={inputClass}
                  {...describedBy("lastName")}
                />
              </Field>
            </div>
            <Field label="Display name" {...field("displayName")}>
              <input
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setDisplayEdited(true);
                }}
                autoComplete="off"
                maxLength={80}
                className={inputClass}
                {...describedBy("displayName")}
              />
            </Field>
            {existing ? (
              <div className="flex flex-col gap-1.5">
                <span className="am-h4">Sign-in address</span>
                <span className="am-code break-all text-foreground">{existing.address}</span>
                <span className="am-micro">
                  They sign in to the webmail and the console with this mailbox. When you finish, it gets a new
                  password, shown to you once, and they choose their own at first sign-in. The current password and the
                  mailbox&apos;s app passwords stop working; a mail app already signed in with the current password
                  stays connected until it disconnects. Until they change it, the new password also works in mail apps.
                </span>
              </div>
            ) : (
              <>
                <Field label="Username" {...field("localPart")}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      value={localPart}
                      onChange={(e) => {
                        setLocalPart(e.target.value);
                      }}
                      placeholder="jane"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      className={`${inputClass} font-mono sm:max-w-56`}
                      {...describedBy("localPart")}
                    />
                    <span aria-hidden className="am-code hidden sm:inline">
                      @
                    </span>
                    <select
                      value={domainId}
                      onChange={(e) => {
                        setDomainId(e.target.value);
                      }}
                      aria-label="Domain"
                      {...(errors.localPart ? { "aria-describedby": `${uid}-err-localPart` } : {})}
                      className={`${inputClass} font-mono sm:max-w-64`}
                    >
                      {options.domains.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.free ? `${d.name} (free address)` : d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </Field>
                <Field label="Storage (GB)" {...field("quotaGb")}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={Math.max(1, options.maxQuotaGb)}
                    value={quotaGb}
                    onChange={(e) => {
                      setQuotaGb(e.target.value);
                    }}
                    className={`${inputClass} am-num sm:max-w-40`}
                    {...describedBy("quotaGb", [`${uid}-note-quotaGb`])}
                  />
                  <span id={`${uid}-note-quotaGb`} className="am-micro">
                    <span className="am-num">{options.maxQuotaGb} GB</span> unassigned. The default is an even share.
                  </span>
                </Field>
                <Toggle
                  checked={autoPassword}
                  onChange={setAutoPassword}
                  label="Automatically create a password"
                  hint="A strong password is created when you finish and shown to you once."
                />
                {!autoPassword && (
                  <div className="flex flex-col gap-1">
                    <MailboxPasswordField value={password} onChange={setPassword} />
                    {fieldError("password")}
                  </div>
                )}
                <Toggle
                  checked={requireChange}
                  onChange={setRequireChange}
                  label="Require this user to change their password when they first sign in"
                  hint="In the webmail and the console, before anything else. Until they change it, the password also works in mail apps."
                />
              </>
            )}
          </Section>
        )}

        {step === "role" && (
          <Section title="Role" lead="What this user can do in the console. Most people only need Member.">
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Role</legend>
              {options.roles.map((r) => (
                <label
                  key={r}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                    role === r ? "border-primary bg-primary/5" : "hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={r}
                    checked={role === r}
                    onChange={() => {
                      setRole(r);
                    }}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="am-h4">{ROLE_LABELS[`account:${r}`]}</span>
                    <span className="am-small">{ACCOUNT_ROLE_SUMMARIES[r]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {fieldError("role")}
          </Section>
        )}

        {step === "profile" && (
          <Section title="Optional settings" lead="Profile details for your records. All optional; skip any you like.">
            <ProfileFieldsGrid profile={profile} onChange={setProfile} errors={errors} />
          </Section>
        )}

        {step === "review" && (
          <Section title="Review and finish" lead="Check the details, then finish to create the user.">
            <Summary
              title="Display and username"
              onEdit={() => {
                go("basics");
              }}
            >
              <p className="am-body">{displayName.trim()}</p>
              <p className="am-small">
                {names(firstName, lastName)} · <span className="am-code break-all">{address}</span>
              </p>
            </Summary>
            <Summary
              title="Password"
              onEdit={() => {
                go("basics");
              }}
            >
              <p className="am-body">{autoPassword ? "Auto-generated" : "Set by you"}</p>
              <p className="am-small">
                {requireChange ? "Must be changed at first sign-in." : "Doesn't have to be changed at first sign-in."}
              </p>
            </Summary>
            {!existing && (
              <Summary
                title="Storage"
                onEdit={() => {
                  go("basics");
                }}
              >
                <p className="am-body">
                  <span className="am-num">{quotaGb} GB</span>
                </p>
              </Summary>
            )}
            <Summary
              title="Role"
              onEdit={() => {
                go("role");
              }}
            >
              <p className="am-body">{ROLE_LABELS[`account:${role}`]}</p>
              <p className="am-small">{ACCOUNT_ROLE_SUMMARIES[role]}</p>
            </Summary>
            <Summary
              title="Profile info"
              onEdit={() => {
                go("profile");
              }}
            >
              <ProfileSummary profile={profile} />
            </Summary>
            {existing?.delegates && existing.delegates.length > 0 && (
              <section
                aria-labelledby="existing-access"
                className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3.5"
              >
                <h3 id="existing-access" className="am-h4">
                  People who already have access
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {existing.delegates.map((d) => (
                    <li key={d.userId} className="flex flex-col">
                      <span className="text-[14px]">
                        {d.name || d.email}{" "}
                        <span className="font-mono text-[12.5px] break-all text-muted-foreground">{d.email}</span>
                      </span>
                      <span className="am-micro">{d.rights.map((r) => DELEGATION_RIGHT_LABELS[r]).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
                <p className="am-small">
                  They keep it once the mailbox is a user&apos;s
                  {role === "member"
                    ? "."
                    : ", except access given by someone who isn't an owner: only an owner can share an owner's or admin's mailbox."}{" "}
                  Change it on the mailbox&apos;s Delegation tab.
                </p>
              </section>
            )}
            {stepUp && (
              <StepUpForm
                nested
                why="This sets a new password on a mailbox that's already in use, so it needs your console password."
                confirmLabel="Confirm and finish"
                onConfirmed={() => {
                  void finish();
                }}
                onCancel={() => {
                  setStepUp(false);
                }}
              />
            )}
            {submitError && (
              <p role="alert" className="am-small text-destructive">
                {submitError}
              </p>
            )}
          </Section>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-5">
          {index > 0 && (
            <button
              type="button"
              onClick={() => {
                const prev = STEPS[index - 1];
                if (prev) go(prev.id);
              }}
              className={secondaryButtonClass}
            >
              Back
            </button>
          )}
          {step === "review" ? (
            <button
              type="button"
              disabled={pending || stepUp}
              onClick={() => {
                void finish();
              }}
              className={primaryButtonClass}
            >
              <UserPlus className="size-4" aria-hidden />
              {pending ? "Adding…" : existing ? "Make this a user" : "Finish adding"}
            </button>
          ) : (
            <button type="submit" className={primaryButtonClass}>
              Next
            </button>
          )}
          <Link
            href={`/accounts/${accountId}/mailboxes`}
            className="ml-auto text-[14px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="am-h2">{title}</h2>
        <p className="am-small">{lead}</p>
      </div>
      {children}
    </section>
  );
}

/** Hints shown beside a field's label; read as the input's description, never as part of its name. */
const FIELD_HINTS: Partial<Record<string, string>> = {
  lastName: "Optional",
  displayName: "The name people see on mail from this user.",
  localPart: "Also their sign-in address.",
};

/** A labelled field: the label names the input (`describedBy` gives it the matching id), the hint describes it. */
function Field({
  uid,
  name,
  label,
  hint,
  error,
  children,
}: {
  uid: string;
  name: string;
  label: string;
  hint: string | undefined;
  error: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span>
        <label htmlFor={`${uid}-f-${name}`} className="am-h4">
          {label}
        </label>
        {hint && (
          <span id={`${uid}-hint-${name}`} className="am-micro ml-2">
            {hint}
          </span>
        )}
      </span>
      {children}
      {error}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        aria-describedby={`${id}-hint`}
        className="mt-1 size-4 accent-primary"
      />
      <span className="flex flex-col gap-0.5">
        <label htmlFor={id} className="am-body text-foreground">
          {label}
        </label>
        <span id={`${id}-hint`} className="am-micro">
          {hint}
        </span>
      </span>
    </div>
  );
}

function Summary({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border bg-card px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="am-h4">{title}</h3>
        {children}
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 text-[14px] text-primary underline-offset-2 hover:underline"
      >
        Edit
      </button>
    </div>
  );
}

function Done({
  added,
  made,
  accountId,
  webmailUrl,
  consoleUrl,
  onAnother,
}: {
  added: Added;
  /** "Make this a user" (an existing mailbox) rather than a new one. */
  made: boolean;
  accountId: string;
  webmailUrl: string;
  consoleUrl: string;
  onAnother: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="am-h2">User added</h2>
        <p className="am-small">
          <span className="am-code break-all text-foreground">{added.address}</span>{" "}
          {made
            ? "now belongs to them. The new password reaches the mail server within a minute."
            : "is set up on the mail server within a minute."}
        </p>
      </div>
      {added.password !== null && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3.5">
          <p className="am-small text-foreground">
            Their password. Copy it now and give it to them safely; it isn&apos;t shown again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="am-code break-all text-[15px] text-foreground" data-testid="generated-password">
              {added.password}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(added.password ?? "")
                  .then(() => {
                    setCopied(true);
                  })
                  .catch(() => undefined);
              }}
              className={secondaryButtonClass}
            >
              {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border px-4 py-3.5">
        <h3 className="am-h4">Where they sign in</h3>
        <p className="am-small">
          Mail: <span className="am-code">{host(webmailUrl)}</span> · Account settings:{" "}
          <span className="am-code">{host(consoleUrl)}</span>, both with{" "}
          <span className="am-code break-all">{added.address}</span>.
          {added.requirePasswordChange ? " They choose their own password the first time." : ""}
        </p>
        <p className="am-micro">They also appear under People and roles.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {!made && (
          <button type="button" onClick={onAnother} className={primaryButtonClass}>
            <UserPlus className="size-4" aria-hidden />
            Add another user
          </button>
        )}
        <Link href={`/accounts/${accountId}/mailboxes`} className={secondaryButtonClass}>
          Back to mailboxes
        </Link>
      </div>
    </div>
  );
}

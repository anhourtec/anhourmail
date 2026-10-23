// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { AtSign, Check, MailCheck, X } from "lucide-react";
import { type SyntheticEvent, useEffect, useId, useState } from "react";

import { PLATFORM_ADDRESS, platformLocalPartProblem } from "@anhourmail/shared/addresses";

import { callApi } from "../api";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "../ui-classes";
import { MailboxPasswordField } from "./mailbox-password-field";

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; address: string }
  | { state: "unavailable"; address: string }
  | { state: "problem"; message: string };

/** The server's answer for one name (kept with the name it was for, so a stale answer is never shown). */
type Answer = { value: string; check: Check };

/**
 * How long typing pauses before the name is checked: short enough to feel instant, long enough to skip the keystrokes
 * in the middle of a word (each check is rate-limited on the server).
 */
const CHECK_DELAY_MS = 150;

/**
 * "Get your free @<platform domain> address": a name with a live availability check (the naming rules are checked here
 * first, the server answers only available or not), the password the person signs in with (typed or generated), and
 * the address is created for them (`POST …/mailboxes` with `domainId: "platform"`). Needs a confirmed sign-in email:
 * until then it offers to send the link again.
 */
export function ClaimPlatformAddress({
  accountId,
  domain,
  ownerUserId,
  emailVerified,
  email,
  webmailUrl,
}: {
  accountId: string;
  domain: string;
  /** Whose mailbox it is: the person claiming it. */
  ownerUserId: string;
  emailVerified: boolean;
  /** Their sign-in address (where the confirmation link goes). */
  email: string;
  webmailUrl: string;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [verified, setVerified] = useState(emailVerified);
  // Answers already given for this panel, so going back to a name (backspace, retyping) shows it at once without asking
  // again. Creating the address is still checked on the server, so a name taken since is refused there.
  const [known, setKnown] = useState<ReadonlyMap<string, Check>>(() => new Map());

  const value = name.trim().toLowerCase();
  const localProblem = value === "" ? null : platformLocalPartProblem(value);
  // Empty and malformed names are answered here; well-formed ones by the server (the latest answer for this name).
  const check: Check =
    value === ""
      ? { state: "idle" }
      : localProblem
        ? { state: "problem", message: localProblem }
        : !verified
          ? { state: "problem", message: "Confirm your email address first, then names can be checked." }
          : answer?.value === value
            ? answer.check
            : (known.get(value) ?? { state: "checking" });

  useEffect(() => {
    if (!verified || value === "" || platformLocalPartProblem(value) !== null || known.has(value)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const answered = (c: Check, remember = true) => {
          if (remember) setKnown((prev) => new Map(prev).set(value, c));
          setAnswer({ value, check: c });
        };
        try {
          const res = await fetch(
            `/api/accounts/${accountId}/mailboxes/platform-address?name=${encodeURIComponent(value)}`,
            { signal: controller.signal },
          );
          if (res.status === 429) {
            answered({ state: "problem", message: "Too many checks for now. Wait a moment, then try again." }, false);
            return;
          }
          const json = (await res.json().catch(() => null)) as {
            data?: { address: string | null; available: boolean; problem: string | null };
            error?: { message?: string };
          } | null;
          const d = json?.data;
          if (!res.ok || !d) {
            answered(
              { state: "problem", message: json?.error?.message ?? "Couldn't check that name. Try again." },
              false,
            );
          } else if (d.problem) answered({ state: "problem", message: d.problem });
          else if (d.address) answered({ state: d.available ? "available" : "unavailable", address: d.address });
        } catch {
          // Aborted by the next keystroke, or offline: the next change checks again.
        }
      })();
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, accountId, verified, known]);

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/mailboxes`, {
      method: "POST",
      body: { localPart: name.trim(), domainId: "platform", ownerUserId, password },
    });
    setPending(false);
    if (!res.ok) {
      if (res.code === "email_unverified") setVerified(false);
      setError(res.message);
      return;
    }
    const address = (res.data as { address?: unknown } | undefined)?.address;
    setCreated(typeof address === "string" ? address : `${name.trim().toLowerCase()}@${domain}`);
    setPassword("");
    // No refresh here: the page would stop offering the panel (the free address is taken) and close it before the
    // person reads this. Closing the panel loads the list with the new mailbox.
  }

  if (created) {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-lg border bg-muted/40 px-4 py-3.5">
        <p className="am-body flex items-start gap-2">
          <Check className="mt-1 size-4 shrink-0 text-[rgb(var(--am-status-success))]" aria-hidden />
          <span>
            <span className="am-code break-all text-foreground">{created}</span> is yours. It&apos;s set up on the mail
            server within a minute; then sign in to the webmail with it and the password you chose.
          </span>
        </p>
        <a href={`${webmailUrl.replace(/\/$/, "")}/sign-in`} className={`${secondaryButtonClass} w-fit`}>
          Open webmail
        </a>
      </div>
    );
  }

  const canSubmit = verified && check.state === "available" && password !== "" && !pending;

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-2xl flex-col gap-5" noValidate>
      {!verified && <ConfirmEmailNotice email={email} />}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="am-h4">
          Address
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id={`${id}-name`}
            name="localPart"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="jane.doe"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={PLATFORM_ADDRESS.max + 8}
            aria-describedby={`${id}-status ${id}-rules`}
            className={`${inputClass} font-mono sm:max-w-64`}
          />
          <span className="am-code break-all">@{domain}</span>
        </div>
        <p id={`${id}-rules`} className="am-micro">
          {PLATFORM_ADDRESS.min}–{PLATFORM_ADDRESS.max} characters: lowercase letters, numbers, dots, hyphens and
          underscores, starting and ending with a letter or number.
        </p>
        <p id={`${id}-status`} aria-live="polite" className="am-small min-h-5">
          {check.state === "checking" && "Checking…"}
          {check.state === "available" && (
            <span className="inline-flex items-center gap-1.5 text-[rgb(var(--am-status-success))]">
              <Check className="size-4" aria-hidden />
              <span>
                <span className="am-code">{check.address}</span> is available.
              </span>
            </span>
          )}
          {check.state === "unavailable" && (
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <X className="size-4" aria-hidden />
              <span>
                <span className="am-code">{check.address}</span> isn&apos;t available. Try another name.
              </span>
            </span>
          )}
          {check.state === "problem" && <span className="text-destructive">{check.message}</span>}
        </p>
      </div>
      <MailboxPasswordField value={password} onChange={setPassword} forSelf />
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={!canSubmit} className={`${primaryButtonClass} w-fit`}>
        <AtSign className="size-4" aria-hidden />
        {pending ? "Creating…" : "Get this address"}
      </button>
    </form>
  );
}

/** A free address needs a confirmed sign-in email: says so, and sends the link again on request. */
export function ConfirmEmailNotice({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    setState("sending");
    const res = await callApi("/api/me/email-verification", { method: "POST" });
    if (!res.ok) {
      setState("error");
      setMessage(res.message);
      return;
    }
    setState("sent");
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-l-4 border-l-[rgb(var(--am-status-warning))] px-4 py-3">
      <p className="am-body flex items-start gap-2">
        <MailCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          Confirm your email address first. We sent a link to <span className="am-code whitespace-nowrap">{email}</span>{" "}
          when you signed up; open it, then come back here.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={state === "sending" || state === "sent"}
          className={secondaryButtonClass}
        >
          {state === "sending" ? "Sending…" : "Send the link again"}
        </button>
        <span role="status" className="am-small">
          {state === "sent" && "Sent. Check your inbox (and spam folder)."}
          {state === "error" && <span className="text-destructive">{message}</span>}
        </span>
      </div>
    </div>
  );
}

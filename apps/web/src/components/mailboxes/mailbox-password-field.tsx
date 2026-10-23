// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useId, useState } from "react";

import { generateMailboxPassword, MAILBOX_PASSWORD, MAILBOX_PASSWORD_RULES } from "@anhourmail/shared/security";

import { PasswordInput } from "../password-input";
import { inputClass, secondaryButtonClass } from "../ui-classes";

/**
 * A new mailbox password: typed, or generated here in the browser (Web Crypto) and shown once with a copy button so it
 * can be handed to the person. The requirements are listed under the field; the server checks them again. The value
 * leaves the page only in the form's request, where the server hashes it at once.
 */
export function MailboxPasswordField({
  value,
  onChange,
  label = "Password",
  autoFocus = false,
  forSelf = false,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  autoFocus?: boolean;
  /** The person setting it is the one who'll use it (claiming their own address), so no "give it to them" advice. */
  forSelf?: boolean;
}) {
  const id = useId();
  const [generated, setGenerated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-pw`} className="am-h4">
        {label}
      </label>
      {/* Full width on its own row: a typed password stays readable next to password-manager icons, even in a
          narrow side panel. The generator sits on the row below. */}
      <PasswordInput
        id={`${id}-pw`}
        name="password"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setGenerated(null);
        }}
        autoComplete="new-password"
        maxLength={MAILBOX_PASSWORD.max}
        aria-describedby={`${id}-rules`}
        spellCheck={false}
        autoFocus={autoFocus}
        className={inputClass}
      />
      <div className="flex">
        <button
          type="button"
          onClick={() => {
            const next = generateMailboxPassword();
            onChange(next);
            setGenerated(next);
            setCopied(false);
          }}
          className={secondaryButtonClass}
        >
          <KeyRound className="size-4" aria-hidden />
          Generate a strong password
        </button>
      </div>
      {generated !== null && generated === value && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
          <p className="am-small text-foreground">
            {forSelf
              ? "Copy it now and keep it somewhere safe, like a password manager. It isn't shown again once you save."
              : "Copy it now and give it to the person safely. It isn't shown again once you save."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="am-code break-all text-[15px] text-foreground" data-testid="generated-password">
              {generated}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(generated).then(() => {
                  setCopied(true);
                });
              }}
              className={`${secondaryButtonClass} h-8 px-3 text-[13.5px]`}
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      <ul id={`${id}-rules`} className="am-micro flex list-disc flex-col gap-0.5 pl-4">
        {MAILBOX_PASSWORD_RULES.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

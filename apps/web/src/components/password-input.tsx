// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Eye, EyeOff } from "lucide-react";
import { type InputHTMLAttributes, useState } from "react";

/**
 * Password field with a show/hide toggle. The toggle is a real button (keyboard + screen reader friendly,
 * `aria-pressed`), outside the tab order of nothing: it follows the input. Extra right padding leaves room for
 * password-manager icons.
 */
export function PasswordInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={visible ? "text" : "password"} className={`${className} pr-20`} />
      <button
        type="button"
        onClick={() => {
          setVisible((v) => !v);
        }}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        title={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-1 my-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

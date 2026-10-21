// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

import { clearSidebarCookies } from "./sidebar-cookies";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        clearSidebarCookies();
        void fetch("/api/auth/sign-out", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
          .catch(() => undefined)
          .then(() => {
            router.replace("/sign-in");
            router.refresh();
          });
      }}
      className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <LogOut className="size-4" aria-hidden />
      Sign out
    </button>
  );
}

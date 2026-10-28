// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

/** An account page this person's role doesn't include (403, `requireAccountSection`), inside the console frame. */
export default function Forbidden() {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <h1 className="am-h1">Not part of your role</h1>
      <p className="am-body">
        Your role in this account doesn&apos;t include this page. Ask an owner if you need access.
      </p>
      <p className="am-micro am-num">Error 403</p>
      <Link href="/" className="w-fit text-[14px] text-primary underline-offset-2 hover:underline">
        Back to Home
      </Link>
    </div>
  );
}

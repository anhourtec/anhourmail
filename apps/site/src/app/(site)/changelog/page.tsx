// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { getChangelog } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What changed in AnhourMail, newest first.",
  alternates: { canonical: "/changelog" },
};

const dateFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });

export default async function ChangelogPage() {
  const entries = await getChangelog();
  return (
    <div className="am-site-section am-site-wrap flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <h1 className="am-site-h1">What’s new</h1>
        <p className="am-site-lead max-w-[52ch]">Every user-facing change, newest first.</p>
      </header>
      {entries.length === 0 ? (
        <p className="am-site-card text-muted-foreground">No releases yet. The first entry lands with the beta.</p>
      ) : (
        <ol className="flex flex-col divide-y border-y">
          {entries.map((e) => (
            <li key={e.slug} className="grid grid-cols-[minmax(0,1fr)] gap-2 py-6 sm:grid-cols-[10rem_1fr]">
              <div className="flex flex-col gap-1">
                <time dateTime={e.date} className="am-num text-muted-foreground text-sm">
                  {dateFmt.format(new Date(`${e.date}T00:00:00Z`))}
                </time>
                {e.version ? <span className="am-mono">{e.version}</span> : null}
              </div>
              <div className="flex flex-col gap-2">
                <h2 className="am-site-h4">{e.title}</h2>
                <p className="text-muted-foreground">{e.summary}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

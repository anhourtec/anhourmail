// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { CREDITS, THANKS } from "@/lib/credits";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Credits",
  description: "The open-source projects AnhourMail is built on, and their licences.",
  path: "/credits",
});

export default function CreditsPage() {
  return (
    <div className="am-site-section am-site-wrap flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <h1 className="am-site-h1">Credits</h1>
        <p className="am-site-lead max-w-[56ch]">
          AnhourMail stands on a lot of open-source work. Thank you to everyone who builds and maintains it.
        </p>
      </header>

      <section aria-labelledby="mail-server" className="am-site-card flex flex-col gap-2">
        <h2 id="mail-server" className="am-site-h4">
          Mail server
        </h2>
        <p className="text-muted-foreground">
          Mail is handled by{" "}
          <a href="https://github.com/stalwartlabs/stalwart" className="underline underline-offset-4">
            Stalwart
          </a>{" "}
          by Stalwart Labs, licensed under AGPL-3.0. We run it unmodified and configure it through its API. If we ever
          change it, we will publish those changes. This credit does not imply that Stalwart Labs endorses AnhourMail.
        </p>
      </section>

      {THANKS.length > 0 ? (
        <section aria-labelledby="thanks" className="flex flex-col gap-4">
          <h2 id="thanks" className="am-site-h3">
            Special thanks
          </h2>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            {THANKS.map((t) => (
              <li key={t.name} className="am-site-card flex flex-col gap-1">
                <a href={t.url} className="am-site-h4 underline-offset-4 hover:underline">
                  {t.name}
                </a>
                <p className="text-muted-foreground text-sm">{t.why}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="packages" className="flex flex-col gap-4">
        <h2 id="packages" className="am-site-h3">
          Packages and licences
        </h2>
        <p className="am-small">Generated from the installed packages on every release.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Package</th>
                <th className="py-2 pr-4 font-medium">Version</th>
                <th className="py-2 pr-4 font-medium">Licence</th>
              </tr>
            </thead>
            <tbody>
              {CREDITS.map((c) => (
                <tr key={`${c.name}@${c.version}`} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    {c.url ? (
                      <a href={c.url} className="underline-offset-4 hover:underline">
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                  </td>
                  <td className="am-num py-2 pr-4 text-muted-foreground">{c.version}</td>
                  <td className="py-2 pr-4">{c.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

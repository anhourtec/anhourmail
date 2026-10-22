// SPDX-License-Identifier: AGPL-3.0-only
import { CLIENT_USERNAME_HINT, type Platform } from "@anhourmail/shared/platform";

import { CopyValue } from "../copy-value";

/**
 * What to type into a mail app, from this deployment's platform facts (`platform()` on the server, built from
 * `PLATFORM_DOMAIN`; never internal hosts): IMAP and POP3 over implicit TLS, SMTP on 465 (plus 587 with STARTTLS, which
 * some apps insist on), and the address for contacts sync.
 */
const rows = (platform: Platform) =>
  platform.clientEndpoints.filter((e) => e.protocol === "IMAP" || e.protocol === "POP3" || e.protocol === "SMTP");

const PURPOSE: Record<string, string> = {
  IMAP: "Incoming mail (recommended)",
  POP3: "Incoming mail, downloaded",
  SMTP: "Outgoing mail",
};

export function MailAppSettings({ address, platform }: { address: string | null; platform: Platform }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <dt className="am-small">Username</dt>
        <dd className="min-w-0">
          {address ? (
            <CopyValue value={address} label="username" />
          ) : (
            <span className="am-body">{CLIENT_USERNAME_HINT}</span>
          )}
        </dd>
        <dt className="am-small">Password</dt>
        <dd className="am-body">An app password from this page, one per app</dd>
      </dl>
      <ul aria-label="Mail server settings" className="border-t">
        {rows(platform).map((e) => (
          <li
            key={`${e.protocol}-${String(e.port)}`}
            className="flex flex-col gap-1.5 border-b py-3 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)_4rem_6rem] sm:items-start sm:gap-4"
          >
            <span className="text-[14px]">
              {e.protocol}
              <span className="am-micro block">{PURPOSE[e.protocol]}</span>
            </span>
            <CopyValue value={e.host} label={`${e.protocol} server`} />
            <span className="flex gap-3 text-[14px] sm:contents">
              <span>
                <span className="am-micro sm:hidden">Port </span>
                <span className="font-mono">{e.port}</span>
              </span>
              <span>{e.security}</span>
            </span>
          </li>
        ))}
        <li className="flex flex-col gap-1.5 border-b py-3 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start sm:gap-4">
          <span className="text-[14px]">
            Contacts
            <span className="am-micro block">CardDAV</span>
          </span>
          <CopyValue value={platform.carddav.url} label="contacts address" />
        </li>
      </ul>
    </div>
  );
}

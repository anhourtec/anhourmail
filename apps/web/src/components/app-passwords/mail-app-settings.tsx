// SPDX-License-Identifier: AGPL-3.0-only
import { CARDDAV, CLIENT_ENDPOINTS, CLIENT_USERNAME_HINT } from "@anhourmail/shared/platform";

import { CopyValue } from "../copy-value";

/**
 * What to type into a mail app, from the public facts (`packages/shared` platform.ts; never internal hosts): the
 * encrypted ports for IMAP, POP3 and SMTP (plus 587 with STARTTLS, which some apps insist on), and the address for
 * contacts sync.
 */
const ROWS = CLIENT_ENDPOINTS.filter(
  (e) =>
    (e.protocol === "IMAP" || e.protocol === "POP3" || e.protocol === "SMTP") &&
    (e.security === "SSL/TLS" || e.protocol === "SMTP"),
);

const PURPOSE: Record<string, string> = {
  IMAP: "Incoming mail (recommended)",
  POP3: "Incoming mail, downloaded",
  SMTP: "Outgoing mail",
};

export function MailAppSettings({ address }: { address: string | null }) {
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
        {ROWS.map((e) => (
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
          <CopyValue value={CARDDAV.url} label="contacts address" />
        </li>
      </ul>
    </div>
  );
}

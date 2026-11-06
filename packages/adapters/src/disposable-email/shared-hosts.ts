// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail providers that real people and real businesses use, which also host some throwaway domains (ADR-0033). The
 * mail-server check never counts them: a domain with any MX host on these suffixes is judged by the domain list only,
 * and the update script never lists their addresses. Lowercase suffixes, matched on a label boundary.
 */
export const SHARED_MAIL_SUFFIXES: readonly string[] = [
  // Large mailbox providers and business mail.
  "google.com",
  "googlemail.com",
  "outlook.com",
  "icloud.com",
  "yahoodns.net",
  "protonmail.ch",
  "proton.me",
  "zoho.com",
  "zoho.eu",
  "zoho.in",
  "zohomail.com",
  "messagingengine.com",
  "yandex.net",
  "yandex.ru",
  "mail.ru",
  "gmx.net",
  "web.de",
  "qq.com",
  "163.com",
  "naver.com",
  "daum.net",
  "tutanota.de",
  "hey.com",
  // Hosting and registrar mail, forwarding and routing.
  "cloudflare.net",
  "registrar-servers.com",
  "privateemail.com",
  "spaceship.net",
  "regery.net",
  "secureserver.net",
  "ionos.com",
  "ionos.de",
  "kundenserver.de",
  "hostinger.com",
  "titan.email",
  "purelymail.com",
  "migadu.com",
  "mxrouting.net",
  "improvmx.com",
  "forwardemail.net",
  "gandi.net",
  "infomaniak.ch",
  "timeweb.ru",
  "ovh.net",
  "one.com",
  "emailsrvr.com",
  // Inbound for apps and security gateways.
  "amazonaws.com",
  "mailgun.org",
  "sendgrid.net",
  "mailchannels.net",
  "pphosted.com",
  "mimecast.com",
  "barracudanetworks.com",
  // Parking.
  "above.com",
];

/** Whether a mail-server name belongs to a shared provider (`mx.google.com`, `route1.mx.cloudflare.net`). */
export function isSharedMailHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return SHARED_MAIL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

const ipv4 = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
};

/** [network, prefix length] pairs: reserved and private ranges, and shared CDN anycast in front of web hosts. */
const RANGES: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
  // Cloudflare (a bare domain whose web site sits behind it answers with these for its A record).
  ["104.16.0.0", 13],
  ["172.64.0.0", 13],
  ["162.158.0.0", 15],
];

/** Whether an IPv4 address is reserved, private or a shared CDN address (never on the disposable list). */
export function isSharedOrReservedIp(ip: string): boolean {
  const n = ipv4(ip);
  if (n === null) return true;
  return RANGES.some(([net, bits]) => {
    const base = ipv4(net) ?? 0;
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The one layout for AnhourMail's own system mail (password resets, invites, security notices), shared by the web app
 * and the worker. docs/internal/branding.md "Transactional email":
 *
 * - a plain-text part that says everything the HTML part says;
 * - HTML built from `role="presentation"` tables with every style inline (the `<style>` block only adds dark mode and
 *   small-screen padding), 560 px wide and centred, system fonts, brand colours as literal hex (emails are the one
 *   place hex is allowed), a hidden preheader and a solid button with an Outlook VML fallback;
 * - the logo embedded as inline (CID) attachments — never a remote image, no tracking pixels, no rewritten or
 *   parameterised links (CLAUDE.md rule 29). Every interpolated value is escaped.
 */
import { BRAND } from "@anhourmail/shared/platform";

import type { MailAttachment, MailMessage } from ".";
import { EMAIL_LOGO_DARK, EMAIL_LOGO_LIGHT } from "./logo.generated";

/** HTML-escapes text and attribute values (`&`, `<`, `>`, quotes). */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** Where the company is, for the footer of every system email. */

export const LOGO_CID = { light: "logo-light@anhourmail", dark: "logo-dark@anhourmail" } as const;

/** Brand colours (packages/ui tokens) as hex; contrast noted against the surface each sits on. */
const C = {
  page: "#f6f8fb", // --am-surface
  card: "#ffffff",
  line: "#e2e6ec", // --am-line
  ink: "#0f141e", // --am-ink, 17.9:1 on white
  soft: "#475060", // --am-ink-soft, 8.2:1 on white
  mute: "#646e80", // --am-ink-mute, 4.9:1 on the page surface
  accent: "#0369a1", // --am-ink-accent, 5.9:1 on white
  btn: "#0077c8", // --am-btn, white text 4.7:1
  codeBg: "#eef1f6", // --am-surface-2
  // Dark (branding.md "Dark mode"): navy page, card, white text never below 60 %.
  dPage: "#070d18",
  dCard: "#0c1a2e",
  dLine: "#24324a",
  dSoft: "#c2c8d1",
  dMute: "#9ba4b2",
  dAccent: "#38ceff", // --am-cyan-hi
  dCodeBg: "#11223a",
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export type SystemEmailInput = {
  to: string;
  subject: string;
  /** Shown in the inbox list after the subject, hidden in the message. Plain words; no secrets or links. */
  preheader: string;
  /** The title in the card; defaults to the subject. */
  heading?: string;
  greeting: string;
  lines: readonly string[];
  /** Labelled values shown quoted in mono (e.g. a name someone chose), after the lines. */
  facts?: readonly { label: string; value: string }[];
  /** A last line just before the button. */
  closing?: string;
  action: { label: string; url: string };
  /** Muted guidance after the button (e.g. "If you didn't ask, ignore this email"). */
  note?: string;
  /** Why this address got this email; first line of the footer. */
  reason: string;
  /** The deployment's public site host (`platform.hosts.site`), linked plainly in the footer. */
  site: string;
};

/** Only plain web links go in a system email (no `javascript:`, `data:` or relative URLs). */
function httpUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("system email: the action URL is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("system email: the action URL must be http(s)");
  return url;
}

function siteHost(site: string): string {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(site)) throw new Error("system email: site must be a host name");
  return site.toLowerCase();
}

const logoAttachments = (): MailAttachment[] => [
  { filename: "anhourmail-logo.png", contentType: "image/png", content: EMAIL_LOGO_LIGHT.base64, cid: LOGO_CID.light },
  {
    filename: "anhourmail-logo-dark.png",
    contentType: "image/png",
    content: EMAIL_LOGO_DARK.base64,
    cid: LOGO_CID.dark,
  },
];

/** The table-cell button, with a VML round rectangle for desktop Outlook (which ignores padding on links). */
function button(label: string, url: string): string {
  const href = esc(url);
  const text = esc(label);
  // VML needs a fixed width: roughly 9 px per character at 16 px plus the side padding.
  const vmlWidth = Math.max(200, Math.min(520, label.length * 9 + 56));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;border-collapse:separate">
<tr><td align="left">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:${String(vmlWidth)}px" arcsize="18%" stroke="f" fillcolor="${C.btn}">
<w:anchorlock/>
<center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:600">${text}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td class="am-btn" bgcolor="${C.btn}" style="border-radius:8px;background-color:${C.btn}">
<a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;mso-padding-alt:0">${text}</a>
</td></tr></table>
<!--<![endif]-->
</td></tr></table>`;
}

const DARK_CSS = `.am-bg{background-color:${C.dPage}!important}
.am-card{background-color:${C.dCard}!important;border-color:${C.dLine}!important}
.am-ink{color:#ffffff!important}
.am-soft{color:${C.dSoft}!important}
.am-mute{color:${C.dMute}!important}
.am-link{color:${C.dAccent}!important}
.am-code{background-color:${C.dCodeBg}!important;color:#ffffff!important}
.am-rule{border-color:${C.dLine}!important}
.am-logo-light{display:none!important}
.am-logo-dark{display:block!important;max-height:none!important;overflow:visible!important}`;

/** Renders a system email: text part, HTML part and the inline logo. */
export function systemEmail(input: SystemEmailInput): MailMessage {
  const url = httpUrl(input.action.url);
  const site = siteHost(input.site);
  const facts = input.facts ?? [];
  const signature = `${BRAND.product} by ${BRAND.company}`;

  const text = [
    input.greeting,
    "",
    ...input.lines,
    ...(facts.length > 0 ? ["", ...facts.map((f) => `${f.label} "${f.value}"`)] : []),
    ...(input.closing ? ["", input.closing] : []),
    "",
    `${input.action.label}: ${url}`,
    ...(input.note ? ["", input.note] : []),
    "",
    input.reason,
    signature,
    `https://${site}`,
    "",
  ].join("\n");

  const p = (body: string, cls = "am-ink", color: string = C.ink) =>
    `<p class="${cls}" style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${color}">${body}</p>`;
  const body = [
    p(esc(input.greeting)),
    ...input.lines.map((l) => p(esc(l))),
    ...facts.map((f) =>
      p(
        `${esc(f.label)} <code class="am-code" style="font-family:${MONO};font-size:14px;background-color:${C.codeBg};border-radius:4px;padding:2px 6px;color:${C.ink};word-break:break-all">&quot;${esc(f.value)}&quot;</code>`,
      ),
    ),
    ...(input.closing ? [p(esc(input.closing))] : []),
  ].join("\n");

  const heading = esc(input.heading ?? input.subject);
  const logo = (variant: "light" | "dark") => {
    const l = variant === "light" ? EMAIL_LOGO_LIGHT : EMAIL_LOGO_DARK;
    return `<img src="cid:${LOGO_CID[variant]}" width="${String(l.width)}" height="${String(l.height)}" alt="${esc(BRAND.product)}" style="display:block;border:0;outline:none;text-decoration:none;width:${String(l.width)}px;height:${String(l.height)}px;margin:0 auto;font-family:${FONT};font-size:20px;line-height:28px;font-weight:500;color:${C.ink}">`;
  };
  // The dark logo is hidden until the dark-mode block shows it (and never in desktop Outlook).
  const logos = `${logo("light").replace("<img ", '<img class="am-logo-light" ')}
<!--[if !mso]><!--><div class="am-logo-dark" style="display:none;max-height:0;overflow:hidden">${logo("dark")}</div><!--<![endif]-->`;

  // Padding after the preheader keeps clients from pulling body text into the inbox preview.
  const preheaderPad = "&#847;&zwnj;&nbsp;".repeat(60);

  const html = `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(input.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0!important;padding:0!important;width:100%!important}
@media (max-width:600px){.am-outer{padding:20px 12px!important}.am-pad{padding:28px 20px!important}}
@media (prefers-color-scheme:dark){${DARK_CSS}}
${DARK_CSS.split("\n")
  .map((rule) => `[data-ogsc] ${rule}`)
  .join("\n")}
</style>
</head>
<body class="am-bg" style="margin:0;padding:0;width:100%;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;opacity:0;color:${C.page}">${esc(input.preheader)}${preheaderPad}</div>
<table role="presentation" class="am-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="width:100%;background-color:${C.page};border-collapse:collapse">
<tr><td align="center" class="am-outer" style="padding:40px 16px">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto;border-collapse:separate">
<tr><td align="center" style="padding:0 0 24px">
${logos}
</td></tr>
<tr><td class="am-card am-pad" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:12px;padding:36px 40px;text-align:left">
<h1 class="am-ink" style="margin:0 0 20px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:500;color:${C.ink}">${heading}</h1>
${body}
${button(input.action.label, url)}
<p class="am-soft" style="margin:24px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.soft}">If the button doesn't work, copy this link into your browser:<br><a class="am-link" href="${esc(url)}" target="_blank" style="color:${C.accent};text-decoration:underline;word-break:break-all">${esc(url)}</a></p>
${input.note ? `<p class="am-soft am-rule" style="margin:24px 0 0;padding:20px 0 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:22px;color:${C.soft}">${esc(input.note)}</p>` : ""}
</td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-family:${FONT};font-size:12px;line-height:18px">
<p class="am-mute" style="margin:0 0 8px;color:${C.mute}">${esc(input.reason)}</p>
<p class="am-mute" style="margin:0;color:${C.mute}">${esc(signature)}<br><a class="am-mute" href="https://${esc(site)}" target="_blank" style="color:${C.mute};text-decoration:underline">${esc(site)}</a></p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;

  return { to: input.to, subject: input.subject, text, html, attachments: logoAttachments() };
}

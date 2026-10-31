// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { forwardingGuard, GUARD_EXTENSIONS } from "@anhourmail/core/webmail";
import { MAX_SENDER_ENTRIES, SENDER_ADDRESS, senderEntry } from "@anhourmail/shared/senders";
import { MANAGED_SIEVE_SCRIPT, MANAGED_SIEVE_SETTINGS_PREFIX } from "@anhourmail/shared/webmail";

/**
 * The mail-flow settings the webmail manages in the mail server (docs/internal/05-webmail.md "Settings"):
 * automatic replies, forwarding and junk rules, compiled into ONE Sieve script we own (`MANAGED_SCRIPT`) in the
 * mailbox's own account. A Sieve script the person already had active (from a mail app) is kept and run after ours
 * with `include :personal :optional`, so nothing they set up elsewhere is lost.
 *
 * Why Sieve and not JMAP VacationResponse: on Stalwart v0.16.27 enabling VacationResponse installs and activates
 * its own "vacation" script, which deactivates every other script (only one can be active) — forwarding and junk
 * rules would stop. Verified 2026-10-22 (research/stalwart.md "Sieve and automatic replies").
 *
 * Injection: every value from a person reaches the script only as a Sieve quoted string through `sieveString`, and
 * the script never requires the `variables` or `encoded-character` extensions, so `${…}` in a message is plain
 * text. The settings themselves are kept in a comment line as base64url JSON (no line breaks), validated on read.
 */

export const MANAGED_SCRIPT = MANAGED_SIEVE_SCRIPT;
/** Entries in each of the blocked and safe lists (one source: `@anhourmail/shared/senders`). */
export { MAX_SENDER_ENTRIES, senderEntry };
/** Stalwart's `maxSizeScript` is 102,400 bytes; we stay under it with room to spare. */
export const MAX_SCRIPT_BYTES = 95_000;
/** At most this many contact addresses are written into the script (for "contacts only" rules). */
export const MAX_CONTACT_ADDRESSES = 1_000;
export const MAILBOX_RULES_LIMIT_MESSAGE = "Your blocked and safe sender lists are too long. Remove some entries.";
/** One automatic reply per sender per this many days. */
export const VACATION_DAYS = 3;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE = /^[+-](?:0\d|1[0-4])[0-5]\d$/;
const ADDRESS = SENDER_ADDRESS;
/** A script name we may include: what mail apps commonly use, nothing that needs escaping. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;

/** Removes control characters (keeping line breaks when `lines`), trims. */
function clean(s: string, lines: boolean): string {
  const unified = s.replace(/\r\n?/g, "\n");
  return (lines ? unified.replace(/[^\P{Cc}\n]/gu, "") : unified.replace(/\p{Cc}/gu, " ")).trim();
}

const entries = z
  .array(z.string().max(254))
  .max(MAX_SENDER_ENTRIES)
  .transform((list, ctx) => {
    const out = new Set<string>();
    for (const raw of list) {
      const e = senderEntry(raw);
      if (!e) {
        ctx.addIssue({ code: "custom", message: `"${raw.slice(0, 60)}" isn't an address or a domain.` });
        return z.NEVER;
      }
      out.add(e);
    }
    return [...out];
  });

export const VacationInput = z
  .object({
    enabled: z.boolean(),
    from: z.string().regex(DATE).nullable(),
    to: z.string().regex(DATE).nullable(),
    subject: z
      .string()
      .max(200)
      .transform((s) => clean(s, false)),
    message: z
      .string()
      .max(4_000)
      .transform((s) => clean(s, true)),
    contactsOnly: z.boolean(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "The end date is before the start date." })
  .refine((v) => !v.enabled || v.message.length > 0, { message: "Write the reply people will get." });
export type Vacation = z.infer<typeof VacationInput>;

export const JunkInput = z.object({ blocked: entries, safe: entries, trustedOnly: z.boolean() });
export type Junk = z.infer<typeof JunkInput>;

export const ForwardingRule = z.object({
  enabled: z.boolean(),
  address: z.string().max(254).regex(ADDRESS).nullable(),
  keepCopy: z.boolean(),
});
export type Forwarding = z.infer<typeof ForwardingRule>;

export const MailRules = z.object({
  vacation: VacationInput,
  forwarding: ForwardingRule,
  junk: JunkInput,
  /** The person's own script that was active before ours, run after our rules. */
  include: z.string().regex(SCRIPT_NAME).nullable(),
  /** UTC offset for the automatic-reply dates ("-0700"), from the person's time zone when saved. */
  zone: z.string().regex(ZONE),
});
export type MailRules = z.infer<typeof MailRules>;

export const DEFAULT_RULES: MailRules = {
  vacation: { enabled: false, from: null, to: null, subject: "", message: "", contactsOnly: false },
  forwarding: { enabled: false, address: null, keepCopy: true },
  junk: { blocked: [], safe: [], trustedOnly: false },
  include: null,
  zone: "+0000",
};

/** Whether the script needs the person's contact addresses. */
export const usesContacts = (r: MailRules): boolean =>
  (r.vacation.enabled && r.vacation.contactsOnly) || r.junk.trustedOnly;

/** A safe include target: our own script and Stalwart's JMAP vacation script are never included. */
export const includable = (name: string): boolean => name !== MANAGED_SCRIPT && SCRIPT_NAME.test(name);

/**
 * A Sieve quoted string (RFC 5228 §2.4.2): backslash and double quote escaped, control characters dropped, line
 * breaks kept. Nothing else in a string has a meaning while `variables` and `encoded-character` aren't required.
 */
export function sieveString(s: string): string {
  const safe = s.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n]/gu, "");
  return `"${safe.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const list = (values: readonly string[]) => `[${values.map(sieveString).join(", ")}]`;
const JUNK = 'fileinto :specialuse "\\\\Junk" "Junk";';

/** Address and domain tests for a list of entries (domains match the sender's domain exactly). */
function senderTests(values: readonly string[]): string[] {
  const addresses = values.filter((v) => v.includes("@"));
  const domains = values.filter((v) => !v.includes("@"));
  const tests: string[] = [];
  if (addresses.length > 0) tests.push(`address :all :comparator "i;unicode-casemap" :is "from" ${list(addresses)}`);
  if (domains.length > 0) tests.push(`address :domain :comparator "i;unicode-casemap" :is "from" ${list(domains)}`);
  return tests;
}

/** Like `senderTests`, but on the envelope sender (the validated MAIL FROM), for "contacts only" rules. */
function envelopeSenderTests(values: readonly string[]): string[] {
  const addresses = values.filter((v) => v.includes("@"));
  const domains = values.filter((v) => !v.includes("@"));
  const tests: string[] = [];
  if (addresses.length > 0) tests.push(`envelope :all :comparator "i;unicode-casemap" :is "from" ${list(addresses)}`);
  if (domains.length > 0) tests.push(`envelope :domain :comparator "i;unicode-casemap" :is "from" ${list(domains)}`);
  return tests;
}

const anyof = (tests: string[]) => (tests.length === 1 ? (tests[0] ?? "false") : `anyof (${tests.join(", ")})`);
const allof = (tests: string[]) => (tests.length === 1 ? (tests[0] ?? "true") : `allof (${tests.join(", ")})`);

/**
 * Mail that automatic replies and forwarding must not act on: spam Stalwart flagged (its own `X-Spam-Status: Yes`;
 * a forged "No" can't override, `:contains "Yes"` matches any copy of the header), bulk or list mail, other
 * automated mail (`Auto-Submitted` other than `no`), and bounces (empty envelope sender). Verified on v0.16.27.
 */
const SUPPRESS = `anyof (
    header :contains "X-Spam-Status" "Yes",
    header :matches ["List-Id", "List-Unsubscribe", "List-Help", "List-Post"] "?*",
    header :contains "Precedence" ["bulk", "list", "junk"],
    allof (exists "Auto-Submitted", not header :is "Auto-Submitted" "no"),
    envelope :all :is "from" ""
  )`;

const SETTINGS_PREFIX = MANAGED_SIEVE_SETTINGS_PREFIX;

/**
 * The forwarding rule's guard (`forwardingGuard` in `@anhourmail/core/webmail`, one source with the upgrade and the
 * reconciler): no redirect for mail our server found failing DMARC, nor for mail claiming the mailbox's own domain
 * (or a subdomain) without our top-most results saying DMARC passed. Re-exported for the tests and `stack:verify`.
 */
export { dmarcPassRegex, forwardingGuard } from "@anhourmail/core/webmail";

/**
 * Builds the managed script. `identities`: the mailbox's own addresses (automatic replies answer mail to any of
 * them). `contacts`: addresses from the address book, used only by "contacts only" rules (already capped).
 */
export function buildScript(
  rules: MailRules,
  ctx: {
    identities: readonly string[];
    contacts: readonly string[];
    /** Our mail server's authserv-ids (`trustedAuthservIds`), for the forwarding guard. */
    authservIds: readonly string[];
    /** The mailbox's own domain (its address's), for the forwarding guard's own-domain part. */
    mailboxDomain: string | null;
  },
): string {
  const r = MailRules.parse(rules);
  const requires = new Set(["fileinto", "special-use", "mailbox"]);
  const body: string[] = [];

  // 1. Junk rules: safe senders skip them; blocked senders go to Junk; with "trusted only", everyone else too.
  const safe = [...r.junk.safe, ...(r.junk.trustedOnly ? ctx.contacts : [])];
  const branches: [string, string][] = [];
  if (safe.length > 0)
    branches.push([anyof(senderTests(safe)), "  # A safe sender: the junk rules below don't apply."]);
  if (r.junk.blocked.length > 0) branches.push([anyof(senderTests(r.junk.blocked)), `  ${JUNK}\n  stop;`]);
  if (r.junk.trustedOnly) branches.push(["true", `  ${JUNK}\n  stop;`]);
  // A lone "safe" branch would do nothing.
  if (!(branches.length === 1 && safe.length > 0)) {
    branches.forEach(([test, action], i) => {
      body.push(`${i === 0 ? "if" : "elsif"} ${test} {\n${action}\n}`);
    });
  }

  // 2 and 3 only run for ordinary person-to-person mail: never for spam Stalwart flagged, bulk/list mail, other
  // automated mail, or bounces (null envelope sender). This stops automatic replies and forwarding from answering
  // or relaying spam and backscatter. Junk filing above still runs for everything.
  const vacationOn = r.vacation.enabled && !(r.vacation.contactsOnly && ctx.contacts.length === 0);
  if (vacationOn || (r.forwarding.enabled && r.forwarding.address)) {
    requires.add("envelope");
    const quiet: string[] = [];

    // 2. Automatic replies (RFC 5230 vacation already de-dupes per sender and skips auto-submitted mail; the guard
    //    above is belt and suspenders).
    if (vacationOn) {
      requires.add("vacation");
      const tests: string[] = [];
      if (r.vacation.from || r.vacation.to) {
        requires.add("date");
        requires.add("relational");
        if (r.vacation.from)
          tests.push(`currentdate :zone ${sieveString(r.zone)} :value "ge" "date" ${sieveString(r.vacation.from)}`);
        if (r.vacation.to)
          tests.push(`currentdate :zone ${sieveString(r.zone)} :value "le" "date" ${sieveString(r.vacation.to)}`);
      }
      const subject = r.vacation.subject !== "" ? ` :subject ${sieveString(r.vacation.subject)}` : "";
      const addresses = ctx.identities.length > 0 ? ` :addresses ${list(ctx.identities)}` : "";
      const action = `vacation :days ${String(VACATION_DAYS)}${subject}${addresses} ${sieveString(r.vacation.message)};`;
      // "Contacts only" tests the envelope sender (the validated MAIL FROM), not a header anyone can forge.
      if (r.vacation.contactsOnly) tests.push(anyof(envelopeSenderTests(ctx.contacts)));
      quiet.push(tests.length > 0 ? `if ${allof(tests)} {\n    ${action}\n  }` : `  ${action}`.trimStart());
    }

    // 3. Forwarding (the BFF only writes a confirmed target).
    if (r.forwarding.enabled && r.forwarding.address) {
      if (r.forwarding.keepCopy) requires.add("copy");
      const redirect = `redirect${r.forwarding.keepCopy ? " :copy" : ""} ${sieveString(r.forwarding.address)};`;
      // Not for mail that failed DMARC by our own checks, nor own-domain mail our checks didn't pass: it stays in the
      // mailbox (implicit keep), never forwarded.
      const guard = forwardingGuard(ctx.authservIds, ctx.mailboxDomain);
      if (guard?.includes(":index") === true) for (const ext of GUARD_EXTENSIONS) requires.add(ext);
      quiet.push(guard === null ? redirect : `if not ${guard} {\n  ${redirect}\n}`);
    }

    const indented = quiet
      .map((line) =>
        line
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n"),
      )
      .join("\n");
    body.push(`if not ${SUPPRESS} {\n${indented}\n}`);
  }

  const stored = Buffer.from(JSON.stringify({ v: 1, ...r }), "utf8").toString("base64url");
  return [
    `require ${list([...requires])};`,
    "# AnhourMail settings, managed by the webmail. Changes made here are replaced when settings are saved.",
    `${SETTINGS_PREFIX}${stored}`,
    "",
    ...body,
    "",
  ].join("\n");
}

/**
 * The exact upgrade of a managed forwarding script to today's guard (`forwardingGuard(authservIds, mailboxDomain)`):
 * the same text with the one redirect block replaced and the guard's extensions appended to `require`, which is what
 * `buildScript` writes today for the same settings (unit-tested). Accepts only what a generator wrote: the bare
 * redirect (before 2026-10-30), or the redirect inside a guard that is exactly `forwardingGuard` for some ids and
 * domain (so a change of authserv-id or a guard from an earlier build is replaced too). Null when there is nothing to
 * do or the text is anything else: not ours, forwarding off, no usable id, the redirect not found exactly once.
 */
export function upgradeManagedScript(
  text: string,
  authservIds: readonly string[],
  mailboxDomain: string | null,
): string | null {
  const rules = parseScript(text);
  const guard = forwardingGuard(authservIds, mailboxDomain);
  if (!rules?.forwarding.enabled || !rules.forwarding.address || guard === null) return null;
  const redirect = `redirect${rules.forwarding.keepCopy ? " :copy" : ""} ${sieveString(rules.forwarding.address)};`;
  const wanted = `\n  if not ${guard} {\n    ${redirect}\n  }\n`;
  if (text.includes(wanted) || text.split(redirect).length !== 2) return null;
  const blocks = [`\n  ${redirect}\n`, ...olderGuards(text).map((g) => `\n  if not ${g} {\n    ${redirect}\n  }\n`)];
  const found = blocks.filter((b) => text.split(b).length === 2);
  const block = found[0];
  if (found.length !== 1 || block === undefined) return null;
  let out = text.replace(block, wanted);
  if (guard.includes(":index")) {
    const m = /^require \[(.*)\];$/m.exec(out);
    if (!m) return null;
    let have: string[];
    try {
      have = (m[1] ?? "").split(", ").map((x) => JSON.parse(x) as string);
    } catch {
      return null; // not a require line we wrote: leave the script alone
    }
    const next = [...have, ...GUARD_EXTENSIONS.filter((e) => !have.includes(e))];
    out = out.replace(m[0], `require ${list(next)};`);
  }
  return out;
}

/** Guards in `text` that are exactly what `forwardingGuard` writes for the ids and domain they name. */
function olderGuards(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\n {2}if not (.+) \{\n {4}redirect/g)) {
    const g = m[1] ?? "";
    const ids = [...g.matchAll(/"([a-z0-9.-]+);\*dmarc=fail\*"/g)].map((x) => x[1] ?? "");
    const domain = /address :domain :is "from" "([a-z0-9.-]+)"/.exec(g)?.[1] ?? null;
    if (forwardingGuard(ids, domain) === g || forwardingGuard(ids, null) === g) out.push(g);
  }
  return out;
}

/** The settings stored in a managed script, or null when it isn't one of ours (or was edited into something else). */
export function parseScript(text: string): MailRules | null {
  const line = text.split("\n").find((l) => l.startsWith(SETTINGS_PREFIX));
  if (!line) return null;
  try {
    const json: unknown = JSON.parse(
      Buffer.from(line.slice(SETTINGS_PREFIX.length).trim(), "base64url").toString("utf8"),
    );
    const parsed = MailRules.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Contact addresses that fit the script: lowercased, unique, valid, at most `MAX_CONTACT_ADDRESSES` and `budget` bytes. */
export function fitContacts(addresses: readonly string[], budget: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const raw of addresses) {
    const a = raw.trim().toLowerCase();
    if (seen.has(a) || !ADDRESS.test(a)) continue;
    const cost = a.length + 4;
    if (out.length >= MAX_CONTACT_ADDRESSES || used + cost > budget) break;
    seen.add(a);
    out.push(a);
    used += cost;
  }
  return out;
}

/** The UTC offset ("-0700") of `timeZone` at `at`; "+0000" when the zone is unknown. */
export function zoneOffset(timeZone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? "");
    return m ? `${m[1] ?? "+"}${m[2] ?? "00"}${m[3] ?? "00"}` : "+0000";
  } catch {
    return "+0000";
  }
}

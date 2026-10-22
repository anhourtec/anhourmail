// SPDX-License-Identifier: AGPL-3.0-only
import { lexer, type Token, type Tokens } from "marked";

/**
 * Safe, structured message bodies for the reader (docs/internal/05-webmail.md "Reading"). Plain text, markdown and
 * calendar invitations are turned into small data structures here, on the server, and rendered by React as text —
 * no message markup ever reaches the page's DOM. HTML mail keeps the sandboxed frame instead.
 */

// ---- plain text ---------------------------------------------------------------------------------------------

/** A run of plain text: the message itself, a quoted reply (collapsed by default), or the signature (dimmed). */
export type TextBlock = { kind: "text" | "quote" | "signature"; text: string };

/** `format=flowed` (RFC 3676): soft line breaks (a trailing space) are joined; space-stuffing is removed. */
export function unflow(text: string, delsp = false): string {
  const out: { depth: number; text: string; open: boolean }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let depth = 0;
    while (raw[depth] === ">") depth++;
    let line = raw.slice(depth);
    if (line.startsWith(" ")) line = line.slice(1);
    const isSig = line === "-- ";
    const soft = !isSig && line.endsWith(" ");
    const prev = out.at(-1);
    if (prev?.open && prev.depth === depth) {
      prev.text += line;
    } else {
      out.push({ depth, text: line, open: false });
    }
    const cur = out[out.length - 1];
    if (cur) {
      cur.open = soft;
      if (soft && delsp) cur.text = cur.text.slice(0, -1);
    }
  }
  return out.map((l) => (l.depth > 0 ? `${">".repeat(l.depth)} ${l.text}` : l.text)).join("\n");
}

const ATTRIBUTION = /^(On\s.{4,300}\s(?:wrote|écrit|schrieb|escribió)\s?:|.{0,200}\bwrote:)\s*$/i;

/** Removes one level of `>` quoting. */
const unquote = (lines: string[]) => lines.map((l) => l.replace(/^> ?/, ""));

/**
 * Splits plain text into the message, quoted replies (with their "On … wrote:" line) and the signature (after a
 * `-- ` line, RFC 3676 §4.3). Line breaks are preserved; quoted text loses one level of `>`.
 */
export function textBlocks(input: string, opts: { flowed?: boolean; delsp?: boolean } = {}): TextBlock[] {
  const text = opts.flowed ? unflow(input, opts.delsp) : input.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  // The signature starts at the last "-- " line outside quotes.
  let sigAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "-- " || lines[i] === "--") {
      sigAt = i;
      break;
    }
  }
  const body = sigAt >= 0 ? lines.slice(0, sigAt) : lines;
  const blocks: TextBlock[] = [];
  const push = (kind: TextBlock["kind"], ls: string[]) => {
    const t = ls.join("\n").replace(/^\n+|\n+$/g, "");
    if (t.trim() === "") return;
    const last = blocks.at(-1);
    if (last?.kind === kind) last.text += `\n\n${t}`;
    else blocks.push({ kind, text: t });
  };
  let i = 0;
  let plain: string[] = [];
  while (i < body.length) {
    const line = body[i] ?? "";
    // An attribution line followed (maybe after blank lines) by quoted lines starts a quote block.
    let j = i;
    if (ATTRIBUTION.test(line)) {
      j = i + 1;
      while (j < body.length && (body[j] ?? "").trim() === "") j++;
    }
    if ((body[j] ?? "").startsWith(">") && (j === i || ATTRIBUTION.test(line))) {
      push("text", plain);
      plain = [];
      const quoted: string[] = [];
      let k = j;
      while (
        k < body.length &&
        ((body[k] ?? "").startsWith(">") || ((body[k] ?? "") === "" && (body[k + 1] ?? "").startsWith(">")))
      ) {
        quoted.push(body[k] ?? "");
        k++;
      }
      const head = j === i ? [] : [line];
      push("quote", [...head, ...unquote(quoted)]);
      i = k;
      continue;
    }
    plain.push(line);
    i++;
  }
  push("text", plain);
  if (sigAt >= 0) push("signature", lines.slice(sigAt + 1));
  return blocks;
}

// ---- markdown -----------------------------------------------------------------------------------------------

export type MdInline =
  | { t: "text"; v: string }
  | { t: "strong" | "em" | "del"; c: MdInline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: MdInline[] }
  | { t: "br" };

export type MdBlock =
  | { t: "h"; level: number; c: MdInline[] }
  | { t: "p"; c: MdInline[] }
  | { t: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: "quote"; c: MdBlock[] }
  | { t: "code"; v: string }
  | { t: "hr" };

/** Largest markdown body we render (bytes, already capped by the caller), nesting depth and node count. */
export const MAX_MARKDOWN = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/**
 * Markdown as a small AST: headings, paragraphs, lists, quotes, code, rules, and inline emphasis, code, links
 * (http/https/mailto only) and line breaks. Raw HTML and images become plain text (never markup, never a remote
 * load). Bounded in depth and size.
 */
export function markdownBlocks(input: string): MdBlock[] {
  let nodes = 0;
  const count = () => ++nodes <= MAX_NODES;

  const inline = (tokens: Token[] | undefined, depth: number): MdInline[] => {
    const out: MdInline[] = [];
    for (const tok of tokens ?? []) {
      if (!count()) break;
      switch (tok.type) {
        case "strong":
        case "em":
        case "del":
          out.push(
            depth < MAX_DEPTH
              ? { t: tok.type, c: inline((tok as Tokens.Strong).tokens, depth + 1) }
              : { t: "text", v: tok.raw },
          );
          break;
        case "codespan":
          out.push({ t: "code", v: (tok as Tokens.Codespan).text });
          break;
        case "br":
          out.push({ t: "br" });
          break;
        case "link": {
          const l = tok as Tokens.Link;
          const label = depth < MAX_DEPTH ? inline(l.tokens, depth + 1) : [{ t: "text" as const, v: l.text }];
          out.push(SAFE_HREF.test(l.href) ? { t: "link", href: l.href, c: label } : { t: "text", v: l.text });
          break;
        }
        case "image": {
          const im = tok as Tokens.Image;
          out.push({ t: "text", v: im.text ? `[image: ${im.text}]` : "[image]" });
          break;
        }
        case "text": {
          const tx = tok as Tokens.Text;
          if (tx.tokens && tx.tokens.length > 0 && depth < MAX_DEPTH) out.push(...inline(tx.tokens, depth + 1));
          else out.push({ t: "text", v: tx.text });
          break;
        }
        case "escape":
          out.push({ t: "text", v: (tok as Tokens.Escape).text });
          break;
        default:
          // html and anything unknown: shown as its source text, never interpreted.
          out.push({ t: "text", v: tok.raw });
      }
    }
    return out;
  };

  const block = (tokens: Token[], depth: number): MdBlock[] => {
    const out: MdBlock[] = [];
    for (const tok of tokens) {
      if (!count()) break;
      switch (tok.type) {
        case "heading": {
          const h = tok as Tokens.Heading;
          out.push({ t: "h", level: Math.min(Math.max(h.depth, 1), 6), c: inline(h.tokens, depth) });
          break;
        }
        case "paragraph":
          out.push({ t: "p", c: inline((tok as Tokens.Paragraph).tokens, depth) });
          break;
        case "list": {
          const l = tok as Tokens.List;
          out.push({
            t: "list",
            ordered: l.ordered,
            start: typeof l.start === "number" ? l.start : 1,
            items: depth < MAX_DEPTH ? l.items.map((it) => block(it.tokens, depth + 1)) : [],
          });
          break;
        }
        case "blockquote":
          if (depth < MAX_DEPTH) out.push({ t: "quote", c: block((tok as Tokens.Blockquote).tokens, depth + 1) });
          break;
        case "code":
          out.push({ t: "code", v: (tok as Tokens.Code).text });
          break;
        case "hr":
          out.push({ t: "hr" });
          break;
        case "space":
          break;
        case "text": {
          const tx = tok as Tokens.Text;
          out.push({ t: "p", c: tx.tokens ? inline(tx.tokens, depth) : [{ t: "text", v: tx.text }] });
          break;
        }
        default:
          // html blocks, tables and anything else: their source as a plain paragraph.
          if (tok.raw.trim() !== "") out.push({ t: "p", c: [{ t: "text", v: tok.raw.trim() }] });
      }
    }
    return out;
  };

  return block(lexer(input.slice(0, MAX_MARKDOWN), { gfm: true, breaks: false }), 0);
}

// ---- calendar invitations -----------------------------------------------------------------------------------

export type CalendarEvent = {
  summary: string;
  /** ISO 8601 (UTC instants), or a date for all-day events, or a local "YYYY-MM-DDTHH:MM" when only a zone name was given. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  /** The TZID the times were given in, when they weren't UTC. */
  timeZone: string | null;
  location: string | null;
  organizer: { name: string | null; email: string | null } | null;
  description: string | null;
  /** REQUEST (an invitation), CANCEL, PUBLISH… */
  method: string | null;
};

const unescapeIcs = (v: string) =>
  v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c)).slice(0, 2000);

function icsTime(
  value: string,
  params: Record<string, string>,
): { at: string | null; allDay: boolean; tz: string | null } {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || params.VALUE === "DATE") {
    return { at: date ? `${date[1] ?? ""}-${date[2] ?? ""}-${date[3] ?? ""}` : null, allDay: true, tz: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return { at: null, allDay: false, tz: null };
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === "Z")
    return { at: `${y ?? ""}-${mo ?? ""}-${d ?? ""}T${h ?? ""}:${mi ?? ""}:${s ?? ""}Z`, allDay: false, tz: null };
  return { at: `${y ?? ""}-${mo ?? ""}-${d ?? ""}T${h ?? ""}:${mi ?? ""}`, allDay: false, tz: params.TZID ?? null };
}

/** Events from an iCalendar file (RFC 5545): the first few VEVENTs with their main fields. Never throws. */
export function calendarEvents(ics: string, max = 5): CalendarEvent[] {
  const lines = ics
    .slice(0, 256 * 1024)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const events: CalendarEvent[] = [];
  let method: string | null = null;
  let cur: CalendarEvent | null = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const [nameRaw = "", ...paramParts] = line.slice(0, colon).split(";");
    const name = nameRaw.toUpperCase();
    const value = line.slice(colon + 1);
    const params: Record<string, string> = {};
    for (const pp of paramParts) {
      const eq = pp.indexOf("=");
      if (eq > 0) params[pp.slice(0, eq).toUpperCase()] = pp.slice(eq + 1).replace(/^"|"$/g, "");
    }
    if (name === "METHOD" && !cur) method = value.trim().toUpperCase().slice(0, 20);
    else if (name === "BEGIN" && value.trim().toUpperCase() === "VEVENT") {
      cur = {
        summary: "",
        start: null,
        end: null,
        allDay: false,
        timeZone: null,
        location: null,
        organizer: null,
        description: null,
        method,
      };
    } else if (name === "END" && value.trim().toUpperCase() === "VEVENT") {
      if (cur && events.length < max) events.push(cur);
      cur = null;
    } else if (cur) {
      if (name === "SUMMARY") cur.summary = unescapeIcs(value).slice(0, 300);
      else if (name === "LOCATION") cur.location = unescapeIcs(value).slice(0, 300);
      else if (name === "DESCRIPTION") cur.description = unescapeIcs(value);
      else if (name === "DTSTART" || name === "DTEND") {
        const t = icsTime(value.trim(), params);
        if (name === "DTSTART") {
          cur.start = t.at;
          cur.allDay = t.allDay;
          cur.timeZone = t.tz;
        } else cur.end = t.at;
      } else if (name === "ORGANIZER") {
        const email = /^mailto:(.+)$/i.exec(value.trim())?.[1] ?? null;
        cur.organizer = { name: params.CN ? params.CN.slice(0, 200) : null, email: email ? email.slice(0, 254) : null };
      }
    }
  }
  return events;
}

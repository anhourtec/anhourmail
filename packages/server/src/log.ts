// SPDX-License-Identifier: MIT
/**
 * Structured JSON logging for server code: one JSON object per line on stdout.
 *
 *   import { log } from "@anhourmail/server/log";
 *   log.info("domain verified", { domainId, hostname });
 *   const l = log.child({ component: "domains" }); l.warn("re-check failed", { err });
 *
 * Every line has `time` (ISO), `level`, `msg`, `service` (LOG_SERVICE: web, worker, scheduler), `env`, the child bindings, the
 * context passed to the call and — during a request — `requestId` (registered by the app's request context).
 *
 * - `LOG_LEVEL` = trace | debug | info (default) | warn | error | fatal | silent.
 * - `LOG_PRETTY=true` prints a short human line instead of JSON, outside production only.
 * - Redaction is by key, at any depth: every key in REDACT_KEYS (case, `-` and `_` ignored) is replaced by
 *   "[redacted]", and `Bearer …` inside strings is masked. Add a key here whenever a new secret appears.
 * - Errors (`err` / any Error value) become `{ type, message, stack? }`; the stack only at error/fatal.
 * - Never pass request or response bodies, and never mail content: subjects, bodies, MIME, attachments
 *   and recipient lists are redacted by key and must not be logged under any other key (CLAUDE.md rule 24).
 *
 * No `server-only` and no env import on purpose: the Next proxy and the worker use it too, and logging must
 * work even when the rest of the environment is invalid.
 */

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LogLevel = keyof typeof LEVELS;
export type LogContext = Record<string, unknown>;

export type Logger = {
  trace(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  /** Write at a level chosen at run time (e.g. the access log's status-based level). */
  at(level: LogLevel, msg: string, ctx?: LogContext): void;
  child(bindings: LogContext): Logger;
  enabled(level: LogLevel): boolean;
};

/**
 * Keys whose values are never logged, compared after lower-casing and dropping `-` / `_`
 * (so `set-cookie`, `setCookie` and `SET_COOKIE` all match).
 */
export const REDACT_KEYS: readonly string[] = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "setcookie",
  "password",
  "newpassword",
  "currentpassword",
  "passwordencrypted",
  "smtppassword",
  "token",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "verificationtoken",
  "invitetoken",
  "resettoken",
  "tokenhash",
  "secret",
  // two-step verification
  "otp",
  "totpuri",
  "backupcodes",
  "backupcode",
  "twofactorsecret",
  "clientsecret",
  "webhooksecret",
  "betterauthsecret",
  "apikey",
  "xapikey",
  "privatekey",
  "keypem",
  "customkeyenc",
  "csrkeyenc",
  "xhubsignature",
  "xhubsignature256",
  "requestbody",
  "responsebody",
  "reqbody",
  "resbody",
  // AnhourMail: mail credentials and keys
  "dkimprivatekey",
  "apppassword",
  "jmaptoken",
  "stalwartadminpassword",
  "stalwartapikey",
  "masterpassword",
  "recoverycode",
  "sourcepassword",
  "imappassword",
  "stripesecretkey",
  "stripewebhooksecret",
  // AnhourMail: mail content never reaches logs
  "subject",
  "body",
  "htmlbody",
  "textbody",
  "preview",
  "attachments",
  "raw",
  "mime",
  "headers",
  "to",
  "cc",
  "bcc",
  "recipients",
];

const REDACT = new Set(REDACT_KEYS);
const SERVICE = process.env.LOG_SERVICE ?? "anhourmail";
const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_STRING = 2_000;

const normKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

function scrubString(s: string): string {
  const masked = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
}

function serializeError(err: Error, withStack: boolean): LogContext {
  const out: LogContext = { type: err.name, message: scrubString(err.message) };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  if (withStack && err.stack) out.stack = scrubString(err.stack);
  return out;
}

/** Deep copy with redacted keys, serialized errors, truncated strings and no cycles. */
export function redact(value: unknown, withStack = false, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return serializeError(value, withStack);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, withStack, depth + 1, seen));
  if (value instanceof Headers) {
    const out: LogContext = {};
    value.forEach((v, k) => {
      out[k] = REDACT.has(normKey(k)) ? REDACTED : scrubString(v);
    });
    return out;
  }
  const out: LogContext = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || typeof v === "function") continue;
    out[k] = REDACT.has(normKey(k)) ? REDACTED : redact(v, withStack, depth + 1, seen);
  }
  return out;
}

// ---- configuration -------------------------------------------------------------------------------

type Config = { min: number; pretty: boolean; env: string };
let config: Config | null = null;

function readConfig(): Config {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const min = raw === "silent" ? Number.POSITIVE_INFINITY : raw in LEVELS ? LEVELS[raw as LogLevel] : LEVELS.info;
  const env = process.env.NODE_ENV ?? "development";
  return { min, pretty: process.env.LOG_PRETTY === "true" && env !== "production", env };
}

const cfg = () => {
  config ??= readConfig();
  return config;
};

/** Request-scoped fields (requestId) added to every line; registered by the app's request context. */
let contextProvider: (() => LogContext | undefined) | null = null;
export function setLogContextProvider(fn: () => LogContext | undefined): void {
  contextProvider = fn;
}

type Sink = (line: string) => void;
const stdoutSink: Sink = (line) => {
  process.stdout.write(`${line}\n`);
};
let sink: Sink = stdoutSink;

/** Tests only: capture lines instead of writing them, and re-read LOG_LEVEL / LOG_PRETTY. Pass null to restore. */
export function setLogSinkForTests(fn: Sink | null): void {
  sink = fn ?? stdoutSink;
  config = null;
}

function pretty(rec: LogContext): string {
  const { time, level, msg, service: _s, env: _e, ...rest } = rec;
  const t = String(time).slice(11, 23);
  const extras = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${t} ${String(level).toUpperCase().padEnd(5)} ${String(msg)}${extras ? `  ${extras}` : ""}`;
}

function write(level: LogLevel, bindings: LogContext, msg: string, ctx?: LogContext) {
  const c = cfg();
  if (LEVELS[level] < c.min) return;
  const withStack = LEVELS[level] >= LEVELS.error;
  let request: LogContext | undefined;
  try {
    request = contextProvider?.();
  } catch {
    request = undefined;
  }
  const rec = {
    time: new Date().toISOString(),
    level,
    msg: scrubString(msg),
    service: SERVICE,
    env: c.env,
    ...(redact({ ...request, ...bindings, ...ctx }, withStack) as LogContext),
  };
  let line: string;
  try {
    line = c.pretty ? pretty(rec) : JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ time: rec.time, level, msg: rec.msg, service: SERVICE, env: c.env, logError: true });
  }
  try {
    sink(line);
  } catch {
    // logging must never break the request
  }
}

function make(bindings: LogContext): Logger {
  return {
    trace: (msg, ctx) => {
      write("trace", bindings, msg, ctx);
    },
    debug: (msg, ctx) => {
      write("debug", bindings, msg, ctx);
    },
    info: (msg, ctx) => {
      write("info", bindings, msg, ctx);
    },
    warn: (msg, ctx) => {
      write("warn", bindings, msg, ctx);
    },
    error: (msg, ctx) => {
      write("error", bindings, msg, ctx);
    },
    fatal: (msg, ctx) => {
      write("fatal", bindings, msg, ctx);
    },
    at: (level, msg, ctx) => {
      write(level, bindings, msg, ctx);
    },
    child: (more) => make({ ...bindings, ...more }),
    enabled: (level) => LEVELS[level] >= cfg().min,
  };
}

/** The root logger. Use `log.child({ component })` for a subsystem. */
export const log: Logger = make({});

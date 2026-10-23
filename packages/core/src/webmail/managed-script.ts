// SPDX-License-Identifier: AGPL-3.0-only
import { MANAGED_SIEVE_SETTINGS_PREFIX } from "@anhourmail/shared/webmail";

import { mutation } from "../mutation";
import type { Deps } from "../ports";

/**
 * Reads a mailbox's managed Sieve script on the mail server (adapter: the scheduler's read-only audit key) with whether
 * it is the active one. Null when it has none.
 */
export type ManagedScriptReader = { read(externalId: string): Promise<{ content: string; active: boolean } | null> };

export type ManagedScriptFindings = {
  /** The settings line we write is there and readable. */
  ours: boolean;
  /** Forwarding as the settings line records it. */
  forwarding: { enabled: boolean; address: string | null } | null;
  /** Every `redirect` target in the script, lowercased. */
  redirects: string[];
  /** Requires or uses an extension we never write (notify, enotify, extprograms, include of a non-personal script). */
  foreign: string[];
};

/** Extensions the webmail never requires: anything that sends, runs or computes. */
const NEVER = new Set([
  "enotify",
  "notify",
  "variables",
  "extprograms",
  "vnd.stalwart.expressions",
  "vnd.dovecot.pipe",
  "vnd.dovecot.execute",
]);

/**
 * Splits Sieve source into code (comments dropped, every quoted string replaced by `"#<n>"`) and the strings' values,
 * so keywords are only ever matched in code, never inside a message or a subject.
 */
function tokenize(text: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let code = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === '"') {
      let value = "";
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i += 1;
        value += text[i] ?? "";
        i += 1;
      }
      i += 1;
      code += `"#${String(strings.length)}"`;
      strings.push(value);
    } else if (/^text:/i.test(text.slice(i, i + 5))) {
      // Multi-line string (RFC 5228 §2.4.2): up to a line holding a single dot.
      const end = text.indexOf("\n.\n", i);
      const stop = end === -1 ? text.length : end + 3;
      code += `"#${String(strings.length)}"`;
      strings.push(text.slice(i + 5, stop));
      i = stop;
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, strings };
}

/**
 * What a managed script contains that matters for safety: who it redirects to and whether it is still the script the
 * webmail writes (`apps/web/src/server/webmail/sieve.ts`). It doesn't rebuild the whole script: that needs the
 * mailbox's contacts, which the control plane doesn't read.
 */
export function inspectManagedScript(text: string): ManagedScriptFindings {
  const line = text.split("\n").find((l) => l.startsWith(MANAGED_SIEVE_SETTINGS_PREFIX));
  let forwarding: ManagedScriptFindings["forwarding"] = null;
  if (line) {
    try {
      const json = JSON.parse(
        Buffer.from(line.slice(MANAGED_SIEVE_SETTINGS_PREFIX.length).trim(), "base64url").toString("utf8"),
      ) as { forwarding?: { enabled?: unknown; address?: unknown } };
      const f = json.forwarding;
      if (f && typeof f.enabled === "boolean") {
        forwarding = { enabled: f.enabled, address: typeof f.address === "string" ? f.address.toLowerCase() : null };
      }
    } catch {
      forwarding = null;
    }
  }
  const { code, strings } = tokenize(text);
  const str = (n: string | undefined) => strings[Number(n)] ?? "";
  const redirects = [...code.matchAll(/\bredirect\b(?:\s+:[a-z]+)*\s+"#(\d+)"/gi)].map((m) => str(m[1]).toLowerCase());
  const foreign: string[] = [];
  // A redirect whose target isn't one plain string (a list, an expression) can't be checked.
  if ((code.match(/\bredirect\b/gi) ?? []).length > redirects.length) foreign.push("redirect-expression");
  for (const req of code.matchAll(/\brequire\s+(\[[^\]]*\]|"#\d+")/gi)) {
    for (const ref of (req[1] ?? "").matchAll(/"#(\d+)"/g)) {
      const ext = str(ref[1]).toLowerCase();
      if (NEVER.has(ext)) foreign.push(ext);
    }
  }
  return { ours: forwarding !== null, forwarding, redirects, foreign };
}

export type ManagedScriptDrift = {
  checked: number;
  /** A script without our settings line (replaced or edited by hand). */
  notOurs: number;
  /** A redirect to anything but the mailbox's confirmed forwarding target (or any redirect while it has none). */
  unconfirmedRedirects: number;
  /** Extensions or constructs the webmail never writes. */
  foreign: number;
  /**
   * Our script exists but isn't the active one (users can't switch it off; by hand, or an account locked late). Shown
   * as "inactive" in the webmail settings and re-activated by the next save there; reported here, not re-queued.
   */
  inactive: number;
  /** Mailboxes the mail server couldn't answer for. */
  unreachable: number;
  /** Mailboxes queued for `mailbox.ensure` (re-asserts the customer lock; never rewrites or deletes anything). */
  requeued: number;
  clean: boolean;
};

const RECONCILER = { kind: "system", name: "reconcile" } as const;

/**
 * Reconciler: checks every active mailbox's managed Sieve script against what the control plane allows — the
 * webmail's own settings line, redirects only to the confirmed forwarding target, nothing the webmail never writes.
 * Matters because the web app's operations key can write Sieve on any account (ADR-0020). Reports and audits drift
 * (`platform.reconciler_drift`, counts only) and re-queues `mailbox.ensure` for those mailboxes; never deletes or
 * rewrites a script (CLAUDE.md rule 26) — a person looks at it.
 */
export async function reconcileManagedScripts(deps: Deps, reader: ManagedScriptReader): Promise<ManagedScriptDrift> {
  const mailboxes = (await deps.uow.run((r) => r.appPasswords.mailboxesOnServer())).filter(
    (m) => m.status === "active",
  );
  const out: ManagedScriptDrift = {
    checked: 0,
    notOurs: 0,
    unconfirmedRedirects: 0,
    foreign: 0,
    inactive: 0,
    unreachable: 0,
    requeued: 0,
    clean: true,
  };
  const requeue: string[] = [];
  for (const m of mailboxes) {
    const script = await reader.read(m.stalwartId).catch(() => undefined);
    if (script === undefined) {
      out.unreachable += 1;
      continue;
    }
    if (script === null) continue; // no managed script yet: nothing set
    out.checked += 1;
    if (!script.active) out.inactive += 1;
    const found = inspectManagedScript(script.content);
    const target = await deps.uow.run((r) => r.webmailSettings.forwarding(m.id));
    const confirmed = target?.status === "confirmed" ? target.address.toLowerCase() : null;
    let drift = false;
    if (!found.ours) {
      out.notOurs += 1;
      drift = true;
    }
    if (found.redirects.some((a) => a !== confirmed)) {
      out.unconfirmedRedirects += 1;
      drift = true;
    }
    if (found.foreign.length > 0) {
      out.foreign += 1;
      drift = true;
    }
    if (drift) requeue.push(m.id);
  }
  out.requeued = requeue.length;
  out.clean = out.notOurs + out.unconfirmedRedirects + out.foreign + out.inactive + out.unreachable === 0;
  if (!out.clean) {
    const now = deps.clock.now();
    await mutation(
      deps,
      RECONCILER,
      { requestId: `reconcile-sieve-${String(now.getTime())}`, ip: null, userAgent: null },
      {
        action: "platform.reconciler_drift",
        permission: "self.profile.read",
        accountId: null,
        target: { type: "mail_server", label: "managed sieve scripts" },
      },
      async (repos) => {
        for (const id of requeue) {
          await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: id, runAfter: now });
        }
        return {
          result: undefined,
          meta: {
            scriptsChecked: out.checked,
            scriptsNotOurs: out.notOurs,
            unconfirmedRedirects: out.unconfirmedRedirects,
            foreignScripts: out.foreign,
            scriptsInactive: out.inactive,
            mailboxesUnreachable: out.unreachable,
            requeued: out.requeued,
          },
        };
      },
    );
  }
  return out;
}

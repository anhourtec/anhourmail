// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ExternalLink, HardDrive, LogOut, MailCheck, Plus, TriangleAlert, X } from "lucide-react";
import { type SyntheticEvent, useId, useState } from "react";

import { UNDO_SEND_SECONDS, type WebmailPreferences } from "@anhourmail/shared/webmail";

/** Storage sizes: MB below a gigabyte, else GB with one decimal ("1.6 MB", "30 GB"). */
const storage = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB`
    : `${(bytes / 1024 ** 2).toFixed(1).replace(/\.0$/, "")} MB`;
import { type Identity, type MailClient, RefusedError, type SettingsOverview } from "../mail-client";
import { areaClass, Choice, fieldClass, Group, Note, Row, smallPrimary, smallSecondary, Toggle } from "./controls";

type Change = (patch: Partial<WebmailPreferences>) => void;
type Status = { tone: "ok" | "error"; text: string } | null;

/** "Saved." / an error, announced politely next to a form's button. */
function StatusText({ status }: { status: Status }) {
  return (
    <span
      aria-live="polite"
      className={`am-small ${status?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {status?.text ?? ""}
    </span>
  );
}

const messageOf = (err: unknown) =>
  err instanceof RefusedError ? err.message : "That didn't save. Check your connection and try again.";

/** Our rules were switched off on the mail server (a user-side deactivation); any save turns them back on. */
function RulesOff({ data }: { data: SettingsOverview }) {
  if (data.rulesState !== "inactive") return null;
  return (
    <p role="note" className="am-small flex gap-2 rounded-lg border bg-accent px-3 py-2.5 text-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[rgb(var(--am-status-warning-bg))]" aria-hidden />
      Your automatic replies, forwarding and junk rules are switched off on the mail server. Saving any of them turns
      them back on.
    </p>
  );
}

// ---- Writing ----------------------------------------------------------------------------------------------

export function WritingPanel({
  prefs,
  onChange,
  data,
  client,
  onIdentities,
}: {
  prefs: WebmailPreferences;
  onChange: Change;
  data: SettingsOverview;
  client: MailClient;
  onIdentities: (list: Identity[]) => void;
}) {
  const [identityId, setIdentityId] = useState(data.identities[0]?.id ?? "");
  const identity = data.identities.find((i) => i.id === identityId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = drafts[identityId] ?? identity?.signature ?? "";
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!identity) return;
    setBusy(true);
    setStatus(null);
    try {
      const updated = await client.updateIdentity(data.accountId, identity.id, { signature: text });
      onIdentities(data.identities.map((i) => (i.id === updated.id ? updated : i)));
      setStatus({ tone: "ok", text: "Signature saved." });
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${fieldId}-h`} className="flex flex-col gap-2">
        <h3 id={`${fieldId}-h`} className="font-medium text-[14px]">
          Signature
        </h3>
        <p className="am-small max-w-prose">
          Added below new messages, replies and forwards. Each address has its own. Mail apps keep their own signatures.
        </p>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3 rounded-xl border p-4">
          {data.identities.length > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">For</span>
              <select
                value={identityId}
                onChange={(e) => {
                  setIdentityId(e.target.value);
                  setStatus(null);
                }}
                className={`${fieldClass} font-mono text-[13.5px]`}
              >
                {data.identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.email}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label htmlFor={fieldId} className="sr-only">
            Signature for {identity?.email}
          </label>
          <textarea
            id={fieldId}
            value={text}
            maxLength={2000}
            onChange={(e) => {
              setDrafts((d) => ({ ...d, [identityId]: e.target.value }));
              setStatus(null);
            }}
            placeholder={"Sam Lee\nAnhourtec · Victoria, BC"}
            className={`${areaClass} font-mono text-[13.5px]`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || !identity} className={smallPrimary}>
              Save signature
            </button>
            <StatusText status={status} />
          </div>
        </form>
      </section>

      <Group title="Sending">
        <Choice
          label="Reply button"
          description="What Reply and the r key do."
          value={prefs.defaultReply}
          options={[
            { value: "reply", label: "Reply" },
            { value: "replyAll", label: "Reply all" },
          ]}
          onChange={(defaultReply) => {
            onChange({ defaultReply });
          }}
        />
        <Choice
          label="Undo send"
          description="How long you have to take a message back after sending."
          value={prefs.undoSeconds}
          options={UNDO_SEND_SECONDS.map((s) => ({ value: s, label: `${String(s)} s` }))}
          onChange={(undoSeconds) => {
            onChange({ undoSeconds });
          }}
        />
        <Toggle
          label="Always show Cc and Bcc"
          checked={prefs.showCcBcc}
          onChange={(showCcBcc) => {
            onChange({ showCcBcc });
          }}
        />
        <Note label="Messages are sent as plain text">Formatting in the composer is coming later.</Note>
      </Group>
    </div>
  );
}

// ---- Automatic replies ------------------------------------------------------------------------------------

export function RepliesPanel({
  data,
  client,
  timeZone,
  onSaved,
}: {
  data: SettingsOverview;
  client: MailClient;
  timeZone: string;
  onSaved: (next: SettingsOverview) => void;
}) {
  const v = data.rules.vacation;
  const [enabled, setEnabled] = useState(v.enabled);
  const [dated, setDated] = useState(v.from !== null || v.to !== null);
  const [from, setFrom] = useState(v.from ?? "");
  const [to, setTo] = useState(v.to ?? "");
  const [subject, setSubject] = useState(v.subject);
  const [message, setMessage] = useState(v.message);
  const [contactsOnly, setContactsOnly] = useState(v.contactsOnly);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const vacation = await client.saveVacation(
        data.accountId,
        {
          enabled,
          from: dated && from !== "" ? from : null,
          to: dated && to !== "" ? to : null,
          subject,
          message,
          contactsOnly,
        },
        timeZone,
      );
      onSaved({ ...data, rules: { ...data.rules, vacation }, rulesState: "active" });
      setStatus({ tone: "ok", text: enabled ? "Automatic replies are on." : "Automatic replies are off." });
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-6" aria-label="Automatic replies">
      <RulesOff data={data} />
      <Group
        title="Automatic replies"
        description="Answer mail while you're away. Each sender gets one reply every few days; junk and blocked senders get none."
      >
        <Toggle label="Send automatic replies" checked={enabled} onChange={setEnabled} />
        <Toggle label="Only between these dates" checked={dated} onChange={setDated} disabled={!enabled} />
        {dated && enabled && (
          <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">From</span>
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                }}
                className={fieldClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">Until (included)</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => {
                  setTo(e.target.value);
                }}
                className={fieldClass}
              />
            </label>
          </div>
        )}
        <div className="flex flex-col gap-3 px-4 py-3">
          <label htmlFor={`${id}-s`} className="text-[13px] text-muted-foreground">
            Subject (optional)
          </label>
          <input
            id={`${id}-s`}
            value={subject}
            maxLength={200}
            onChange={(e) => {
              setSubject(e.target.value);
            }}
            placeholder="Away until Monday"
            className={fieldClass}
          />
          <label htmlFor={`${id}-m`} className="text-[13px] text-muted-foreground">
            Message
          </label>
          <textarea
            id={`${id}-m`}
            value={message}
            maxLength={4000}
            onChange={(e) => {
              setMessage(e.target.value);
            }}
            placeholder="Thanks for your message. I'm away and will reply when I'm back."
            className={areaClass}
          />
        </div>
        <Toggle
          label="Only reply to my contacts"
          description="People in your contacts. Everyone else gets no reply."
          checked={contactsOnly}
          onChange={setContactsOnly}
        />
      </Group>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={smallPrimary}>
          Save
        </button>
        <StatusText status={status} />
      </div>
    </form>
  );
}

// ---- Forwarding -------------------------------------------------------------------------------------------

export function ForwardingPanel({
  data,
  client,
  onSaved,
}: {
  data: SettingsOverview;
  client: MailClient;
  onSaved: (next: SettingsOverview) => void;
}) {
  const target = data.forwardingTarget;
  const rule = data.rules.forwarding;
  const [address, setAddress] = useState("");
  const [enabled, setEnabled] = useState(rule.enabled && rule.address === target?.address);
  const [keepCopy, setKeepCopy] = useState(rule.keepCopy);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const [openedAt] = useState(() => Date.now());
  const expired =
    target?.status === "pending" && target.expiresAt !== null && new Date(target.expiresAt).getTime() <= openedAt;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const request = (to: string) =>
    run(async () => {
      const out = await client.requestForwarding(data.accountId, to);
      onSaved({
        ...data,
        forwardingTarget: { address: out.target, status: "pending", expiresAt: new Date(Date.now() + 72 * 3_600_000) },
        rules: {
          ...data.rules,
          forwarding: rule.address === out.target ? rule : { ...rule, enabled: false, address: null },
        },
      });
      setAddress("");
      setStatus(
        out.emailed
          ? { tone: "ok", text: `We emailed ${out.target}. Forwarding can start once they confirm.` }
          : { tone: "error", text: "The confirmation email couldn't be sent. Try again in a moment." },
      );
    });

  const remove = () =>
    run(async () => {
      await client.removeForwarding(data.accountId);
      onSaved({
        ...data,
        forwardingTarget: null,
        rules: { ...data.rules, forwarding: { enabled: false, address: null, keepCopy: true } },
      });
      setEnabled(false);
      setStatus({ tone: "ok", text: "Forwarding removed." });
    });

  const save = (e: SyntheticEvent) => {
    e.preventDefault();
    void run(async () => {
      const forwarding = await client.setForwarding(data.accountId, enabled, keepCopy);
      onSaved({ ...data, rules: { ...data.rules, forwarding }, rulesState: "active" });
      setStatus({ tone: "ok", text: enabled ? "Forwarding is on." : "Forwarding is off." });
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <RulesOff data={data} />
      <p className="am-small max-w-prose">
        Send new mail to one other address. The person who owns that address confirms it first, so mail is never
        forwarded somewhere by mistake. Junk and mail from blocked senders is never forwarded.
      </p>

      {target === null || expired ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void request(address);
          }}
          className="flex flex-col gap-3 rounded-xl border p-4"
        >
          {expired && (
            <p className="am-small">
              The link sent to <span className="font-mono">{target.address}</span> expired. Send a new one.
            </p>
          )}
          <label htmlFor={`${id}-a`} className="text-[14px]">
            Forward to
          </label>
          <input
            id={`${id}-a`}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            required
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
            }}
            placeholder="name@example.com"
            className={`${fieldClass} font-mono`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || address.trim() === ""} className={smallPrimary}>
              Send confirmation
            </button>
            <StatusText status={status} />
          </div>
        </form>
      ) : target.status === "pending" ? (
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <p className="flex items-start gap-2 text-[14px]">
            <MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              Waiting for <span className="font-mono">{target.address}</span> to confirm. Nothing is forwarded until
              they do.
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void request(target.address)}
              className={smallSecondary}
            >
              Send again
            </button>
            <button type="button" disabled={busy} onClick={() => void remove()} className={smallSecondary}>
              Cancel
            </button>
            <StatusText status={status} />
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4">
          <Group title="Forwarding">
            <Row label="Forward to" description="Confirmed by its owner.">
              <span className="font-mono text-[13.5px]">{target.address}</span>
            </Row>
            <Toggle label="Forward my mail" checked={enabled} onChange={setEnabled} />
            <Toggle
              label="Keep a copy here"
              description="Off deletes nothing already here, but new forwarded mail won't stay in this mailbox."
              checked={keepCopy}
              onChange={setKeepCopy}
            />
          </Group>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={busy} className={smallPrimary}>
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => void remove()} className={smallSecondary}>
              Remove address
            </button>
            <StatusText status={status} />
          </div>
        </form>
      )}
    </div>
  );
}

// ---- Junk and blocked senders -----------------------------------------------------------------------------

function SenderList({
  label,
  description,
  entries,
  onChange,
}: {
  label: string;
  description: string;
  entries: string[];
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState("");
  const id = useId();
  const add = () => {
    const parts = text
      .split(/[\s,;]+/)
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p !== "");
    if (parts.length === 0) return;
    onChange([...new Set([...entries, ...parts])]);
    setText("");
  };
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-2">
      <h3 id={`${id}-h`} className="font-medium text-[14px]">
        {label}
      </h3>
      <p className="am-small max-w-prose">{description}</p>
      <div className="flex flex-col gap-3 rounded-xl border p-4">
        <div className="flex gap-2">
          <label htmlFor={`${id}-i`} className="sr-only">
            Add to {label.toLowerCase()}
          </label>
          <input
            id={`${id}-i`}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="name@example.com or example.com"
            className={`${fieldClass} font-mono`}
          />
          <button type="button" onClick={add} className={smallSecondary} aria-label={`Add to ${label.toLowerCase()}`}>
            <Plus className="size-4" aria-hidden /> Add
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="am-micro">None yet.</p>
        ) : (
          <ul aria-label={label} className="flex flex-wrap gap-1.5">
            {entries.map((e) => (
              <li
                key={e}
                className="inline-flex items-center gap-1 rounded-md bg-accent py-0.5 pr-1 pl-2 text-[12.5px]"
              >
                <span className="font-mono">{e}</span>
                <button
                  type="button"
                  aria-label={`Remove ${e}`}
                  onClick={() => {
                    onChange(entries.filter((x) => x !== e));
                  }}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function JunkPanel({
  data,
  client,
  onSaved,
}: {
  data: SettingsOverview;
  client: MailClient;
  onSaved: (next: SettingsOverview) => void;
}) {
  const [blocked, setBlocked] = useState(data.rules.junk.blocked);
  const [safe, setSafe] = useState(data.rules.junk.safe);
  const [trustedOnly, setTrustedOnly] = useState(data.rules.junk.trustedOnly);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const junk = await client.saveJunk(data.accountId, { blocked, safe, trustedOnly });
      setBlocked(junk.blocked);
      setSafe(junk.safe);
      onSaved({ ...data, rules: { ...data.rules, junk }, rulesState: "active" });
      setStatus({ tone: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-6" aria-label="Junk and blocked senders">
      <RulesOff data={data} />
      <SenderList
        label="Blocked senders"
        description="Mail from these addresses or domains goes straight to Junk. To report a single message, use Report junk."
        entries={blocked}
        onChange={setBlocked}
      />
      <SenderList
        label="Safe senders"
        description="Mail from these addresses or domains is never moved to Junk by your rules."
        entries={safe}
        onChange={setSafe}
      />
      <Group title="Stricter filtering">
        <Toggle
          label="Only trust my contacts and safe senders"
          description="Mail from anyone else goes to Junk. Check Junk now and then."
          checked={trustedOnly}
          onChange={setTrustedOnly}
        />
      </Group>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={smallPrimary}>
          Save
        </button>
        <StatusText status={status} />
      </div>
    </form>
  );
}

// ---- Account ----------------------------------------------------------------------------------------------

export function AccountPanel({
  prefs,
  onChange,
  data,
  client,
  consoleHref,
  onIdentities,
  onSignOut,
}: {
  prefs: WebmailPreferences;
  onChange: Change;
  data: SettingsOverview;
  client: MailClient;
  consoleHref: string;
  onIdentities: (list: Identity[]) => void;
  onSignOut: () => void;
}) {
  const primary = data.identities.find((i) => i.email.toLowerCase() === data.address.toLowerCase());
  const aliases = data.identities.filter((i) => i !== primary);
  // The mail server names an identity after its address until someone sets a name: show that as empty.
  const [name, setName] = useState(primary && primary.name !== primary.email ? primary.name : "");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const pct = data.quota.limit ? Math.min(100, Math.round((data.quota.used / data.quota.limit) * 100)) : null;

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!primary) return;
    setBusy(true);
    setStatus(null);
    try {
      const updated = await client.updateIdentity(data.accountId, primary.id, { name });
      onIdentities(data.identities.map((i) => (i.id === updated.id ? updated : i)));
      setName(updated.name);
      setStatus({ tone: "ok", text: "Name saved." });
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${id}-h`} className="flex flex-col gap-2">
        <h3 id={`${id}-h`} className="font-medium text-[14px]">
          You
        </h3>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-muted-foreground">Mailbox address</span>
            <span className="font-mono text-[14px]">{data.address}</span>
          </div>
          <label htmlFor={`${id}-n`} className="text-[13px] text-muted-foreground">
            Your name, as people see it
          </label>
          <input
            id={`${id}-n`}
            value={name}
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              setStatus(null);
            }}
            placeholder="Sam Lee"
            className={fieldClass}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || !primary} className={smallPrimary}>
              Save name
            </button>
            <StatusText status={status} />
          </div>
        </form>
      </section>

      <Group title="Addresses you can send from">
        {aliases.length === 0 ? (
          <Note label="No aliases yet">Aliases give you more addresses that reach this mailbox.</Note>
        ) : (
          <ul aria-label="Aliases" className="flex flex-col divide-y">
            {aliases.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="truncate font-mono text-[13.5px]">{a.email}</span>
                {a.name && a.name !== a.email && <span className="am-micro truncate">{a.name}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="px-4 py-3">
          <a
            href={consoleHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13.5px] text-primary hover:underline"
          >
            Manage aliases in the console <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      </Group>

      <Group title="Storage">
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2 text-[14px]">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden />
            <span>
              <span className="font-mono">{storage(data.quota.used)}</span>
              {data.quota.limit ? (
                <>
                  {" "}
                  of <span className="font-mono">{storage(data.quota.limit)}</span> used
                </>
              ) : (
                " used"
              )}
            </span>
          </div>
          {pct !== null && (
            <div
              role="progressbar"
              aria-label="Storage used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={`h-full rounded-full ${pct >= 90 ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${String(pct)}%` }}
              />
            </div>
          )}
        </div>
      </Group>

      <Group title="Signing out">
        <Toggle
          label="Empty Trash when I sign out"
          description="Deletes everything in Trash for good each time you sign out here."
          checked={prefs.emptyTrashOnSignOut}
          onChange={(emptyTrashOnSignOut) => {
            onChange({ emptyTrashOnSignOut });
          }}
        />
        <div className="px-4 py-3">
          <button type="button" onClick={onSignOut} className={smallSecondary}>
            <LogOut className="size-4" aria-hidden /> Sign out of this mailbox
          </button>
        </div>
      </Group>
    </div>
  );
}

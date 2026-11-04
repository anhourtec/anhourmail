// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";
import {
  folderMoved,
  MAIL_RULES,
  type MailRule,
  MailRule as MailRuleSchema,
  previewFilter,
  type RuleCondition,
} from "@anhourmail/shared/mail-rules";

import { ConfirmDialog, Modal } from "../dialogs";
import { type MailClient, RefusedError, type RulesView } from "../mail-client";
import { fieldClass, smallPrimary, smallSecondary } from "./controls";

/** A rule being edited: a new one has no id until the server gives it one. */
type Draft = Omit<MailRule, "id"> & { id?: string };

const FIELDS: { value: RuleCondition["field"]; label: string }[] = [
  { value: "from", label: "From" },
  { value: "toCc", label: "To or Cc" },
  { value: "subject", label: "Subject" },
  { value: "listId", label: "Mailing list (List-Id)" },
  { value: "attachment", label: "Has an attachment" },
  { value: "size", label: "Size" },
];

const blankCondition = (field: RuleCondition["field"]): RuleCondition => {
  switch (field) {
    case "attachment":
      return { field };
    case "size":
      return { field, op: "over", kb: 1024 };
    case "from":
    case "toCc":
      return { field, op: "contains", value: "" };
    default:
      return { field, op: "contains", value: "" };
  }
};

const newDraft = (): Draft => ({
  name: "",
  enabled: true,
  match: "all",
  conditions: [blankCondition("from")],
  actions: { move: null, markRead: false, flag: false, forward: false, stop: false },
});

/** One line saying what a condition looks at ("From contains news@"). */
function describeCondition(c: RuleCondition): string {
  const label = FIELDS.find((f) => f.value === c.field)?.label ?? c.field;
  if (c.field === "attachment") return label;
  if (c.field === "size") return `${label} ${c.op === "over" ? "over" : "under"} ${String(c.kb)} KB`;
  return `${label} ${c.op === "is" ? "is" : "contains"} “${c.value}”`;
}

function describeActions(rule: MailRule | Draft, paths: ReadonlyMap<string, string>): string {
  const a = rule.actions;
  const parts: string[] = [];
  if (a.markRead) parts.push("mark as read");
  if (a.flag) parts.push("flag");
  if (a.forward) parts.push("forward a copy");
  if (a.move?.kind === "folder") parts.push(`move to ${paths.get(a.move.folderId) ?? a.move.path}`);
  if (a.move?.kind === "trash") parts.push("move to Trash");
  if (a.stop && a.move === null) parts.push("stop");
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const messageOf = (err: unknown) =>
  err instanceof RefusedError ? err.message : "That didn't save. Check your connection and try again.";

/**
 * Mail rules (ADR-0032 §2): the ordered list with on/off, order, edit and delete, and "Add rule". Every change saves
 * the whole list against the version it was read at; the server compiles it into the mailbox's managed rules.
 */
export function RulesPanel({ client, account }: { client: MailClient; account: string }) {
  const [view, setView] = useState<RulesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; draft: Draft } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    client
      .rules()
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {
        if (live) setLoadError("Your rules couldn't be loaded. Check your connection and try again.");
      });
    return () => {
      live = false;
    };
  }, [client, attempt]);
  const load = () => {
    setLoadError(null);
    setAttempt((n) => n + 1);
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="am-small">{loadError}</p>
        <button type="button" className={smallSecondary} onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (!view) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading rules</span>
        <Bone className="h-4 w-64" />
        <Bone className="h-16 w-full rounded-xl" />
        <Bone className="h-16 w-full rounded-xl" />
        <Bone className="h-9 w-28 rounded-lg" />
      </div>
    );
  }
  const paths = new Map(view.folders.map((f) => [f.id, f.path]));

  const save = async (rules: Draft[], text: string): Promise<boolean> => {
    setBusy(true);
    setStatus(null);
    try {
      setView(await client.saveRules(account, rules, view.version));
      setStatus({ tone: "ok", text });
      return true;
    } catch (err) {
      setStatus({ tone: "error", text: messageOf(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rules = view.rules;
  const move = (i: number, by: -1 | 1) => {
    const next = [...rules];
    const [r] = next.splice(i, 1);
    if (!r) return;
    next.splice(i + by, 0, r);
    void save(next, "Order saved.");
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="am-small max-w-prose">
        Rules run in order on new mail as it arrives, after your junk rules. Moving a message or sending it to Trash
        ends the list for that message.
      </p>
      {view.rulesState === "inactive" && (
        <p role="note" className="am-small flex gap-2 rounded-lg border bg-accent px-3 py-2.5 text-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Your rules are switched off on the mail server. Saving turns them back on.
        </p>
      )}
      {rules.length === 0 ? (
        <p className="am-small rounded-xl border px-4 py-3">No rules yet.</p>
      ) : (
        <ol aria-label="Mail rules" className="flex flex-col divide-y rounded-xl border">
          {rules.map((r, i) => (
            <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[14px] font-medium">
                  {r.name}
                  {!r.enabled && <span className="am-micro ml-2">Off</span>}
                </span>
                <span className="am-micro truncate">
                  {`If ${r.conditions.map(describeCondition).join(r.match === "all" ? " and " : " or ")}: ${describeActions(r, paths)}`}
                </span>
                {folderMoved(r, paths) && (
                  <span className="am-micro flex items-center gap-1 text-[rgb(var(--am-status-warning))]">
                    <TriangleAlert className="size-3.5" aria-hidden />
                    {paths.has(r.actions.move?.kind === "folder" ? r.actions.move.folderId : "")
                      ? "Its folder was renamed or moved. Edit and save the rule to follow it."
                      : "Its folder was deleted. Mail stays in Inbox until you choose another."}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.enabled}
                  aria-label={`${r.name} on`}
                  disabled={busy}
                  onClick={() => {
                    void save(
                      rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)),
                      r.enabled ? "Rule turned off." : "Rule turned on.",
                    );
                  }}
                  className={`relative inline-flex h-6 w-10 items-center rounded-full transition-colors disabled:opacity-50 ${r.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
                >
                  <span
                    aria-hidden
                    className={`inline-block size-5 rounded-full bg-background shadow-sm transition-transform ${r.enabled ? "translate-x-[1.125rem]" : "translate-x-0.5"}`}
                  />
                </button>
                <IconButton
                  label={`Move ${r.name} up`}
                  disabled={busy || i === 0}
                  onClick={() => {
                    move(i, -1);
                  }}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </IconButton>
                <IconButton
                  label={`Move ${r.name} down`}
                  disabled={busy || i === rules.length - 1}
                  onClick={() => {
                    move(i, 1);
                  }}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </IconButton>
                <IconButton
                  label={`Edit ${r.name}`}
                  onClick={() => {
                    setEditing({ index: i, draft: r });
                  }}
                >
                  <Pencil className="size-4" aria-hidden />
                </IconButton>
                <IconButton
                  label={`Delete ${r.name}`}
                  disabled={busy}
                  onClick={() => {
                    setRemoving(i);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </IconButton>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={smallPrimary}
          disabled={busy || rules.length >= MAIL_RULES.maxRules}
          onClick={() => {
            setEditing({ index: null, draft: newDraft() });
          }}
        >
          <Plus className="size-4" aria-hidden />
          Add rule
        </button>
        <span
          aria-live="polite"
          className={`am-small ${status?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status?.text ?? ""}
        </span>
      </div>
      {rules.length >= MAIL_RULES.maxRules && (
        <p className="am-micro">{`A mailbox can have up to ${String(MAIL_RULES.maxRules)} rules.`}</p>
      )}
      {editing && (
        <RuleEditor
          client={client}
          view={view}
          initial={editing.draft}
          onClose={() => {
            setEditing(null);
          }}
          onSave={async (draft) => {
            const next: Draft[] =
              editing.index === null ? [...rules, draft] : rules.map((x, j) => (j === editing.index ? draft : x));
            const ok = await save(next, "Rule saved.");
            if (ok) setEditing(null);
            return ok;
          }}
          error={status?.tone === "error" ? status.text : null}
        />
      )}
      {removing !== null && (
        <ConfirmDialog
          title={`Delete ${rules[removing]?.name ?? "this rule"}?`}
          body="Mail it would have handled stays where it lands. Messages it already moved stay where they are."
          confirm="Delete rule"
          onClose={() => {
            setRemoving(null);
          }}
          onConfirm={() => {
            void save(
              rules.filter((_, j) => j !== removing),
              "Rule deleted.",
            );
          }}
        />
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const selectClass =
  "h-9 rounded-lg border bg-background px-2.5 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The add / edit dialog: name, conditions, actions, and a preview on recent Inbox mail. */
function RuleEditor({
  client,
  view,
  initial,
  onClose,
  onSave,
  error,
}: {
  client: MailClient;
  view: RulesView;
  initial: Draft;
  onClose: () => void;
  onSave: (draft: Draft) => Promise<boolean>;
  error: string | null;
}) {
  const id = useId();
  const [d, setD] = useState<Draft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ id: string; subject: string; from: string }[] | "loading" | null>(null);
  const inbox = view.folders.find((f) => f.path.toLowerCase() === "inbox")?.id;
  const folders = view.folders.filter((f) => f.id !== inbox);

  const setCondition = (i: number, c: RuleCondition) => {
    setD({ ...d, conditions: d.conditions.map((x, j) => (j === i ? c : x)) });
    setPreview(null);
  };
  const actions = d.actions;
  const setActions = (patch: Partial<Draft["actions"]>) => {
    setD({ ...d, actions: { ...actions, ...patch } });
  };
  /** Checked here with the shared schema (the server checks again); the message names no value. */
  const check = (): MailRule | null => {
    const parsed = MailRuleSchema.safeParse({ ...d, id: d.id ?? "00000000-0000-4000-8000-000000000000" });
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    setProblem(issue?.code === "custom" || issue?.code === "too_small" ? issue.message : "Check the rule's fields.");
    return null;
  };

  return (
    <Modal title={initial.id ? "Edit rule" : "Add rule"} onClose={onClose} size="lg">
      <form
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          if (!check()) return;
          setSaving(true);
          void onSave(d).finally(() => {
            setSaving(false);
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-[14px] font-medium">
            Name
          </label>
          <input
            id={`${id}-name`}
            value={d.name}
            maxLength={MAIL_RULES.nameChars}
            onChange={(e) => {
              setD({ ...d, name: e.target.value });
            }}
            className={fieldClass}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] font-medium">When a message arrives</legend>
          <label className="am-small flex items-center gap-2">
            <span>Match</span>
            <select
              value={d.match}
              onChange={(e) => {
                setD({ ...d, match: e.target.value === "any" ? "any" : "all" });
              }}
              className={selectClass}
            >
              <option value="all">all of these</option>
              <option value="any">any of these</option>
            </select>
          </label>
          {d.conditions.map((c, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg border p-2.5 sm:flex-row sm:items-center">
              <select
                aria-label={`Condition ${String(i + 1)}`}
                value={c.field}
                onChange={(e) => {
                  const f = FIELDS.find((x) => x.value === e.target.value)?.value;
                  if (f) setCondition(i, blankCondition(f));
                }}
                className={selectClass}
              >
                {FIELDS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
              {(c.field === "from" || c.field === "toCc") && (
                <select
                  aria-label={`How condition ${String(i + 1)} matches`}
                  value={c.op}
                  onChange={(e) => {
                    setCondition(i, { ...c, op: e.target.value === "is" ? "is" : "contains" });
                  }}
                  className={selectClass}
                >
                  <option value="contains">contains</option>
                  <option value="is">is the address</option>
                </select>
              )}
              {(c.field === "subject" || c.field === "listId") && <span className="am-small">contains</span>}
              {"value" in c && (
                <input
                  aria-label={`Text for condition ${String(i + 1)}`}
                  value={c.value}
                  maxLength={MAIL_RULES.valueChars}
                  spellCheck={false}
                  onChange={(e) => {
                    setCondition(i, { ...c, value: e.target.value });
                  }}
                  className={`${fieldClass} sm:flex-1`}
                />
              )}
              {c.field === "size" && (
                <span className="flex items-center gap-2">
                  <select
                    aria-label={`Size comparison for condition ${String(i + 1)}`}
                    value={c.op}
                    onChange={(e) => {
                      setCondition(i, { ...c, op: e.target.value === "under" ? "under" : "over" });
                    }}
                    className={selectClass}
                  >
                    <option value="over">over</option>
                    <option value="under">under</option>
                  </select>
                  <input
                    aria-label={`Size in KB for condition ${String(i + 1)}`}
                    type="number"
                    min={1}
                    max={MAIL_RULES.maxSizeKb}
                    value={c.kb}
                    onChange={(e) => {
                      setCondition(i, { ...c, kb: Math.trunc(Number(e.target.value)) || 1 });
                    }}
                    className={`${fieldClass} w-28 font-mono`}
                  />
                  <span className="am-small">KB</span>
                </span>
              )}
              {d.conditions.length > 1 && (
                <IconButton
                  label={`Remove condition ${String(i + 1)}`}
                  onClick={() => {
                    setD({ ...d, conditions: d.conditions.filter((_, j) => j !== i) });
                    setPreview(null);
                  }}
                >
                  <X className="size-4" aria-hidden />
                </IconButton>
              )}
            </div>
          ))}
          {d.conditions.length < MAIL_RULES.maxConditions && (
            <button
              type="button"
              className={`${smallSecondary} w-fit`}
              onClick={() => {
                setD({ ...d, conditions: [...d.conditions, blankCondition("subject")] });
              }}
            >
              <Plus className="size-4" aria-hidden />
              Add condition
            </button>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] font-medium">Do this</legend>
          <label className="am-small flex flex-wrap items-center gap-2">
            <span>Move to</span>
            <select
              value={actions.move === null ? "" : actions.move.kind === "trash" ? "trash" : actions.move.folderId}
              onChange={(e) => {
                const v = e.target.value;
                setActions({
                  move:
                    v === ""
                      ? null
                      : v === "trash"
                        ? { kind: "trash" }
                        : { kind: "folder", folderId: v, path: folders.find((f) => f.id === v)?.path ?? "" },
                });
              }}
              className={selectClass}
            >
              <option value="">Leave in Inbox</option>
              <option value="trash">Trash (delete)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>
          <Check
            label="Mark as read"
            checked={actions.markRead}
            onChange={(v) => {
              setActions({ markRead: v });
            }}
          />
          <Check
            label="Flag it"
            checked={actions.flag}
            onChange={(v) => {
              setActions({ flag: v });
            }}
          />
          <Check
            label={view.forwardTo ? `Forward a copy to ${view.forwardTo}` : "Forward a copy"}
            hint={
              view.forwardTo
                ? "Your confirmed forwarding address. Mailing-list, automated and junk mail is never forwarded."
                : "Set up and confirm a forwarding address in Forwarding first."
            }
            disabled={!view.forwardTo && !actions.forward}
            checked={actions.forward}
            onChange={(v) => {
              setActions({ forward: v });
            }}
          />
          <Check
            label="Stop processing more rules"
            hint={actions.move !== null ? "Moving a message always ends the list." : undefined}
            disabled={actions.move !== null}
            checked={actions.stop || actions.move !== null}
            onChange={(v) => {
              setActions({ stop: v });
            }}
          />
        </fieldset>

        <section aria-labelledby={`${id}-preview`} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`${id}-preview`} className="text-[14px] font-medium">
              Recent messages this rule matches
            </h3>
            <button
              type="button"
              className={smallSecondary}
              disabled={!inbox || preview === "loading"}
              onClick={() => {
                setProblem(null);
                const rule = check();
                if (!rule || !inbox) return;
                setPreview("loading");
                client
                  .previewRule(inbox, previewFilter(rule))
                  .then(setPreview)
                  .catch(() => {
                    setPreview(null);
                    setProblem("The preview couldn't be loaded. Try again.");
                  });
              }}
            >
              <Search className="size-4" aria-hidden />
              Check Inbox
            </button>
          </div>
          {preview === "loading" && <Bone className="h-10 w-full rounded-lg" />}
          {Array.isArray(preview) &&
            (preview.length === 0 ? (
              <p className="am-micro">None of your recent Inbox messages match.</p>
            ) : (
              <ul aria-label="Matching messages" className="am-small flex flex-col divide-y rounded-lg border">
                {preview.map((m) => (
                  <li key={m.id} className="flex min-w-0 gap-2 px-3 py-1.5">
                    <span className="shrink-0 font-medium">{m.from}</span>
                    <span className="truncate text-muted-foreground">{m.subject || "(no subject)"}</span>
                  </li>
                ))}
              </ul>
            ))}
          <p className="am-micro">A close check on mail you already have; new mail is matched as it arrives.</p>
        </section>

        <label className="am-small flex items-center gap-2">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => {
              setD({ ...d, enabled: e.target.checked });
            }}
            className="size-4 accent-primary"
          />
          Rule is on
        </label>

        {(problem ?? error) && (
          <p role="alert" className="am-small text-destructive">
            {problem ?? error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={smallSecondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={smallPrimary} disabled={saving}>
            {saving ? "Saving…" : "Save rule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Check({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? "opacity-60" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        className="mt-0.5 size-4 accent-primary"
      />
      <span className="flex flex-col">
        <span className="text-[14px]">{label}</span>
        {hint && <span className="am-micro">{hint}</span>}
      </span>
    </label>
  );
}

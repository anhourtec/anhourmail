// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";

import { REGIONS, type WebmailPreferences } from "@anhourmail/shared/webmail";

import { folderLabel, folderTree } from "../format";
import type { Folder, ListRow } from "../mail-client";
import { MessageRow, rowHeight } from "../message-list";
import { Choice, Group, Note, SelectRow, Toggle } from "./controls";

type Change = (patch: Partial<WebmailPreferences>) => void;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** Two made-up rows for the live preview (no real mail). */
const SAMPLE: ListRow[] = [
  {
    id: "preview-1",
    threadId: "preview-1",
    mailboxIds: {},
    keywords: {},
    from: [{ name: "Robin Avery", email: "robin@example.org" }],
    to: null,
    subject: "Plans for Saturday",
    receivedAt: hoursAgo(1),
    preview: "Are we still on for the hike? I can bring lunch if you sort out the map and the early start.",
    hasAttachment: true,
    threadSize: 3,
    attachments: [{ name: "trail-map.pdf", type: "application/pdf" }],
  },
  {
    id: "preview-2",
    threadId: "preview-2",
    mailboxIds: {},
    keywords: { $seen: true, $flagged: true },
    from: [{ name: "Kai Morgan", email: "kai@example.net" }],
    to: null,
    subject: "Invoice for October",
    receivedAt: hoursAgo(30),
    preview: "Thanks again for your help this month. The invoice is below; no rush on it.",
    hasAttachment: false,
    threadSize: 1,
  },
];

export function AppearancePanel({ prefs, onChange }: { prefs: WebmailPreferences; onChange: Change }) {
  const h = rowHeight(prefs);
  return (
    <div className="flex flex-col gap-6">
      <div aria-label="Preview of the message list" role="group" className="overflow-hidden rounded-xl border">
        <p className="am-micro border-b bg-muted/40 px-3 py-1.5">Preview</p>
        <div role="listbox" aria-label="Preview messages" className="pointer-events-none">
          {SAMPLE.map((row, i) => (
            <div key={row.id} style={{ height: h }}>
              <MessageRow
                row={row}
                index={i}
                selected={i === 0}
                checked={false}
                selecting={false}
                sentFolder={false}
                look={prefs}
                onOpen={() => undefined}
                onCheck={() => undefined}
              />
            </div>
          ))}
        </div>
      </div>

      <Group title="Look">
        <Choice
          label="Theme"
          value={prefs.theme}
          options={[
            { value: "system", label: "Device" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(theme) => {
            onChange({ theme });
          }}
        />
        <Choice
          label="Density"
          description="Text size and spacing in the message list."
          value={prefs.density}
          options={[
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" },
            { value: "roomy", label: "Roomy" },
          ]}
          onChange={(density) => {
            onChange({ density });
          }}
        />
        <Choice
          label="Reading pane"
          description="Where a message opens. Off shows it in place of the list."
          value={prefs.readingPane}
          options={[
            { value: "right", label: "Right" },
            { value: "bottom", label: "Bottom" },
            { value: "off", label: "Off" },
          ]}
          onChange={(readingPane) => {
            onChange({ readingPane });
          }}
        />
        <Choice
          label="Motion"
          value={prefs.motion}
          options={[
            { value: "system", label: "Follow device" },
            { value: "reduced", label: "Reduced" },
          ]}
          onChange={(motion) => {
            onChange({ motion });
          }}
        />
      </Group>

      <Group title="Message list">
        <Choice
          label="Group messages"
          description="One row per conversation, or every message on its own."
          value={prefs.grouping}
          options={[
            { value: "conversations", label: "By conversation" },
            { value: "messages", label: "Don't group" },
          ]}
          onChange={(grouping) => {
            onChange({ grouping });
          }}
        />
        <Choice
          label="Message preview"
          value={prefs.previewLines}
          options={[
            { value: 0, label: "Off" },
            { value: 1, label: "1 line" },
            { value: 2, label: "2 lines" },
          ]}
          onChange={(previewLines) => {
            onChange({ previewLines });
          }}
        />
        <Toggle
          label="Sender first"
          description="Show who it's from on the first line. Off puts the subject first."
          checked={prefs.senderFirst}
          onChange={(senderFirst) => {
            onChange({ senderFirst });
          }}
        />
        <Toggle
          label="Sender initials"
          checked={prefs.avatars}
          onChange={(avatars) => {
            onChange({ avatars });
          }}
        />
        <Toggle
          label="Attachment names"
          description="Show attached files under each message."
          checked={prefs.attachmentChips}
          onChange={(attachmentChips) => {
            onChange({ attachmentChips });
          }}
        />
        <Toggle
          label="Date headers"
          description="Today, Yesterday, Last week… between messages."
          checked={prefs.dateHeaders}
          onChange={(dateHeaders) => {
            onChange({ dateHeaders });
          }}
        />
      </Group>
    </div>
  );
}

export function ReadingPanel({ prefs, onChange }: { prefs: WebmailPreferences; onChange: Change }) {
  return (
    <div className="flex flex-col gap-6">
      <Group title="Opening mail">
        <Choice
          label="Mark as read"
          value={prefs.markRead}
          options={[
            { value: "open", label: "When opened" },
            { value: "delay", label: "After a moment" },
            { value: "never", label: "Never" },
          ]}
          onChange={(markRead) => {
            onChange({ markRead });
          }}
        />
        {prefs.markRead === "delay" && (
          <SelectRow
            label="Mark as read after"
            value={prefs.markReadDelay}
            options={[2, 5, 10, 30].map((s) => ({ value: s as 2 | 5 | 10 | 30, label: `${String(s)} seconds` }))}
            onChange={(markReadDelay) => {
              onChange({ markReadDelay });
            }}
          />
        )}
        <Choice
          label="After deleting or archiving"
          value={prefs.afterMove}
          options={[
            { value: "next", label: "Open next" },
            { value: "previous", label: "Open previous" },
            { value: "list", label: "Back to list" },
          ]}
          onChange={(afterMove) => {
            onChange({ afterMove });
          }}
        />
        <Toggle
          label="Mark as read when moving"
          description="Archiving, reporting junk or moving to a folder also marks it read."
          checked={prefs.markReadOnMove}
          onChange={(markReadOnMove) => {
            onChange({ markReadOnMove });
          }}
        />
      </Group>
      <Group title="Privacy">
        <Note label="Remote images are blocked">
          Images a sender links to never load, so they can't see when or where you opened their mail. Pictures sent as
          attachments still show.
        </Note>
        <Note label="Read receipts are never sent">
          When a sender asks to know that you read their message, we don't tell them.
        </Note>
      </Group>
    </div>
  );
}

/** Time zones the browser knows (falls back to a short list). */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/Vancouver", "America/Toronto", "Europe/London", "Asia/Kolkata", "Australia/Sydney"];
  }
}

export function RegionPanel({
  prefs,
  onChange,
  folders,
  shortcuts,
}: {
  prefs: WebmailPreferences;
  onChange: Change;
  folders: Folder[];
  shortcuts: readonly [string, string][];
}) {
  const zones = useMemo(() => timeZones(), []);
  const device = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const sample = new Date(Date.UTC(2026, 9, 22, 21, 30));
  const example = sample.toLocaleString(prefs.region, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(prefs.timeZone !== "auto" ? { timeZone: prefs.timeZone } : {}),
    ...(prefs.hourCycle !== "auto" ? { hourCycle: prefs.hourCycle } : {}),
  });
  const startOptions = [
    { value: "inbox", label: "Inbox" },
    { value: "priority", label: "Priority" },
    ...folderTree(folders)
      .filter((n) => n.folder.role !== "inbox")
      .map((n) => ({ value: `folder:${n.folder.id}`, label: `${"  ".repeat(n.depth)}${folderLabel(n.folder)}` })),
  ];
  return (
    <div className="flex flex-col gap-6">
      <Group title="Dates and times">
        <Note label="Language: English">More languages will follow.</Note>
        <SelectRow
          label="Region"
          description={
            <>
              Dates look like <span className="font-mono">{example}</span>
            </>
          }
          value={prefs.region}
          options={REGIONS.map((r) => ({ value: r.id, label: r.label }))}
          onChange={(region) => {
            onChange({ region });
          }}
        />
        <Choice
          label="Time format"
          value={prefs.hourCycle}
          options={[
            { value: "auto", label: "Region's" },
            { value: "h12", label: "12-hour" },
            { value: "h23", label: "24-hour" },
          ]}
          onChange={(hourCycle) => {
            onChange({ hourCycle });
          }}
        />
        <SelectRow
          label="Time zone"
          description="Also used for the dates of automatic replies."
          value={prefs.timeZone}
          options={[
            { value: "auto", label: `This device (${device})` },
            ...zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
          ]}
          onChange={(timeZone) => {
            onChange({ timeZone });
          }}
        />
      </Group>
      <Group title="Starting up">
        <SelectRow
          label="Start in"
          value={startOptions.some((o) => o.value === prefs.startIn) ? prefs.startIn : "inbox"}
          options={startOptions}
          onChange={(startIn) => {
            onChange({ startIn });
          }}
        />
      </Group>
      <Group title="Keyboard">
        <Toggle
          label="Keyboard shortcuts"
          description="Single keys for common actions. Turn off if you use a screen reader's own keys."
          checked={prefs.shortcuts}
          onChange={(shortcuts) => {
            onChange({ shortcuts });
          }}
        />
        {prefs.shortcuts && (
          <dl aria-label="Shortcuts" className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-2">
            {shortcuts.map(([keys, what]) => (
              <div key={keys} className="flex items-center justify-between gap-3">
                <dt className="am-small">{what}</dt>
                <dd className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[12px]">{keys}</dd>
              </div>
            ))}
          </dl>
        )}
      </Group>
    </div>
  );
}

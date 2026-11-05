// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The demo seed's mail import source (ADR-0030 §20, rule 50): `import-source@dev.test`, a mailbox on the dev mail
 * server that stands in for "another provider" (outside production imports can only read from the dev mail server).
 * Filled once over IMAPS with what an import has to handle: nested custom folders, a non-ASCII folder name, Sent,
 * Drafts, Junk and Trash, flags and keywords, dates in 2015, a duplicate Message-ID, a message without one and one
 * flagged `\Deleted`. Re-seeding leaves it alone when its Inbox already has mail.
 *
 * Development only: certificate checks are off for the dev server's self-signed certificate, and nothing here ever
 * connects anywhere but `127.0.0.1`.
 */
import { connect, type TLSSocket } from "node:tls";

/** A tiny tagged-command IMAP session (LOGIN, CREATE, APPEND with LITERAL+, STATUS, LOGOUT). */
async function session(port: number): Promise<{ run: (cmd: string) => Promise<string>; close: () => void }> {
  const socket: TLSSocket = await new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, servername: "localhost" }, () => {
      resolve(s);
    });
    s.once("error", reject);
  });
  let buf = "";
  let waiter: (() => void) | null = null;
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => {
    buf += d;
    waiter?.();
  });
  const until = (test: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("import source: IMAP timed out"));
      }, 15_000);
      const check = () => {
        if (test()) {
          clearTimeout(timer);
          waiter = null;
          resolve();
        }
      };
      waiter = check;
      check();
    });
  await until(() => buf.includes("\r\n"));
  buf = "";
  let n = 0;
  return {
    run: async (cmd) => {
      n += 1;
      const tag = `s${String(n)}`;
      socket.write(`${tag} ${cmd}\r\n`);
      await until(() => new RegExp(`^${tag} (OK|NO|BAD)`, "m").test(buf));
      // Untagged answers (`* STATUS …`) and the tagged completion, together.
      const out = buf;
      buf = "";
      return out;
    },
    close: () => {
      socket.end();
    },
  };
}

const msg = (o: { id: string | null; subject: string; from?: string; body?: string }) =>
  [
    `From: ${o.from ?? "Old Friend <friend@old-provider.test>"}`,
    "To: import-source@dev.test",
    `Subject: ${o.subject}`,
    ...(o.id === null ? [] : [`Message-ID: <${o.id}@old-provider.test>`]),
    "Date: Tue, 3 Feb 2015 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "Hello from the old provider (2015).",
    "",
  ].join("\r\n");

const append = (folder: string, flags: string, raw: string) =>
  `APPEND "${folder}" (${flags}) "03-Feb-2015 10:00:00 +0000" {${String(Buffer.byteLength(raw))}+}\r\n${raw}`;

/** "Übersicht" in modified UTF-7. */
const UMLAUT = "&ANw-bersicht";

/** Fills the source mailbox when its Inbox is empty; returns how many messages it appended (0: already there). */
export async function seedImportSource(address: string, password: string, imapsPort: number): Promise<number> {
  const s = await session(imapsPort);
  try {
    if (!/^s1 OK/m.test(await s.run(`LOGIN "${address}" "${password}"`))) {
      throw new Error("import source: sign-in refused");
    }
    const status = await s.run("STATUS INBOX (MESSAGES)");
    if (!status.includes("MESSAGES 0)")) return 0;
    for (const f of ["Projects/2015/Q1", "Family", UMLAUT]) await s.run(`CREATE "${f}"`);
    const plan: [string, string, string][] = [
      ["INBOX", "\\Seen \\Flagged $Forwarded travel", msg({ id: "trip", subject: "Our trip in March" })],
      ["INBOX", "\\Answered \\Seen", msg({ id: "dinner", subject: "Dinner on Friday?" })],
      ["INBOX", "\\Seen", msg({ id: "trip", subject: "Our trip in March (second copy)" })],
      ["INBOX", "", msg({ id: null, subject: "A note without a Message-ID" })],
      ["INBOX", "\\Deleted", msg({ id: "gone", subject: "Deleted at the old provider" })],
      ...Array.from({ length: 12 }, (_, i): [string, string, string] => [
        "INBOX",
        i % 3 === 0 ? "" : "\\Seen",
        msg({ id: `news-${String(i)}`, subject: `Newsletter ${String(i + 1)}`, from: "News <news@old-provider.test>" }),
      ]),
      ["Projects/2015/Q1", "\\Seen", msg({ id: "q1-plan", subject: "Q1 plan" })],
      ["Projects/2015/Q1", "", msg({ id: "q1-budget", subject: "Q1 budget" })],
      ["Family", "\\Seen", msg({ id: "photos", subject: "Photos from the weekend" })],
      [UMLAUT, "", msg({ id: "ubersicht", subject: "Übersicht" })],
      ["Sent Items", "\\Seen", msg({ id: "sent-1", subject: "Re: Dinner on Friday?", from: address })],
      ["Drafts", "\\Draft", msg({ id: "draft-1", subject: "Half-written reply", from: address })],
      ["Junk Mail", "", msg({ id: "junk-1", subject: "You won a prize", from: "Prize <win@spam.test>" })],
      ["Deleted Items", "\\Seen", msg({ id: "trash-1", subject: "Old receipt" })],
    ];
    let appended = 0;
    for (const [folder, flags, raw] of plan) {
      if (/^s\d+ OK/m.test(await s.run(append(folder, flags, raw)))) appended += 1;
    }
    await s.run("LOGOUT");
    return appended;
  } finally {
    s.close();
  }
}

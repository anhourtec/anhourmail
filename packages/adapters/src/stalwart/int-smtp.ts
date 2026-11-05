// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests only: an implicit-TLS submission connection (465) to the dev mail server that stays open across
 * changes, to see what a mail app that is already signed in can still do (e.g. after its account is suspended). Dev
 * certificates are self-signed: verification off, dev only. Never pointed at anything but the local dev server.
 */
import tls from "node:tls";

/**
 * `send` writes one line and resolves with the reply up to its last line (`NNN text`), "<closed>" when the server
 * dropped the connection or "<no reply>" when it didn't answer within 10 s.
 */
export async function smtpSession(): Promise<{ send(line: string): Promise<string>; close(): void }> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port: Number(process.env.STALWART_SUBMISSIONS_PORT ?? 465),
    rejectUnauthorized: false,
  });
  socket.setEncoding("utf8");
  let buf = "";
  const conn = { closed: false };
  const isClosed = () => conn.closed;
  let wake: (() => void) | null = null;
  socket.on("data", (d: string) => {
    buf += d;
    wake?.();
  });
  for (const event of ["close", "error"] as const) {
    socket.on(event, () => {
      conn.closed = true;
      wake?.();
    });
  }
  /** A complete reply: its last line is `NNN` followed by a space (or nothing). */
  const complete = () => /(^|\r\n)\d{3}( [^\r\n]*)?\r\n$/.test(buf);
  const until = async () => {
    const deadline = Date.now() + 10_000;
    while (!complete() && !isClosed() && Date.now() < deadline) {
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 200);
      });
    }
  };
  await until(); // greeting
  buf = "";
  return {
    async send(line: string) {
      if (isClosed()) return "<closed>";
      buf = "";
      socket.write(`${line}\r\n`);
      await until();
      if (complete()) return buf;
      return `${buf}${isClosed() ? "<closed>" : "<no reply>"}`;
    },
    close: () => socket.destroy(),
  };
}

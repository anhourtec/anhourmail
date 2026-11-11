// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests only: an implicit-TLS submission connection (465) to the dev mail server that stays open across
 * changes, to see what a mail app that is already signed in can still do (e.g. after its account is suspended). Dev
 * certificates are self-signed: verification off, dev only. Never pointed at anything but the local dev server.
 */
import net from "node:net";
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

/**
 * One scripted exchange on a dev mail port: sends `lines` one at a time, each after the previous reply, and resolves
 * with every reply in order (the greeting first). `starttls` sends EHLO + STARTTLS first and upgrades in place;
 * `implicit` is TLS from the start (465, 993). A reply the server sends just before closing is kept. Dev certificates
 * are self-signed: verification off, dev only.
 */
export function smtpExchange(
  port: number,
  mode: "implicit" | "starttls" | "plain",
  lines: readonly string[],
): Promise<string[]> {
  return new Promise((resolve) => {
    let socket: net.Socket =
      mode === "implicit"
        ? tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false })
        : net.connect({ host: "127.0.0.1", port });
    const queue = mode === "starttls" ? ["EHLO int-test", "STARTTLS", ...lines] : [...lines];
    const replies: string[] = [];
    let buf = "";
    let i = -1;
    let upgraded = mode !== "starttls";
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (buf.trim()) replies.push(buf.trim());
      socket.destroy();
      resolve(replies);
    };
    const next = () => {
      i += 1;
      if (i >= queue.length) {
        finish();
        return;
      }
      socket.write(`${queue[i] ?? ""}\r\n`);
    };
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      clearTimeout(timer);
      timer = setTimeout(() => {
        replies.push(buf.trim());
        buf = "";
        if (!upgraded && queue[i] === "STARTTLS") {
          upgraded = true;
          socket.removeAllListeners("data");
          const secure = tls.connect({ socket, rejectUnauthorized: false }, next);
          secure.on("data", onData);
          secure.on("error", finish);
          socket = secure;
          return;
        }
        next();
      }, 250);
    };
    socket.on("data", onData);
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 45_000).unref();
  });
}

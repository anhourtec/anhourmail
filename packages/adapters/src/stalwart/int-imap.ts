// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests only: an IMAPS connection to the dev mail server that stays open across changes, to see what
 * happens to a mail app that is already signed in (e.g. when its password is replaced or its app password revoked).
 */
import tls from "node:tls";

/**
 * An IMAPS connection kept open across a password change (dev certificates are self-signed: verification off, dev
 * only). `run` sends one tagged command and resolves with everything up to its tagged reply, ending in "<closed>" when the
 * server dropped the connection or "<no reply>" when it didn't answer within 10 s.
 */
export async function imapSession(): Promise<{ run(command: string): Promise<string>; close(): void }> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port: Number(process.env.STALWART_IMAPS_PORT ?? 993),
    rejectUnauthorized: false,
  });
  socket.setEncoding("utf8");
  let buf = "";
  // Set from socket events; read through `isClosed` so checks after an await aren't narrowed away.
  const conn = { closed: false };
  const isClosed = () => conn.closed;
  let wake: (() => void) | null = null;
  socket.on("data", (d: string) => {
    buf += d;
    wake?.();
  });
  socket.on("close", () => {
    conn.closed = true;
    wake?.();
  });
  socket.on("error", () => {
    conn.closed = true;
    wake?.();
  });
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!done() && !isClosed() && Date.now() < deadline) {
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 200);
      });
    }
  };
  await until(() => buf.includes("* OK")); // greeting
  let n = 0;
  return {
    async run(command: string) {
      if (isClosed()) return "<closed>";
      n += 1;
      const tag = `t${String(n)}`;
      buf = "";
      socket.write(`${tag} ${command}\r\n`);
      await until(() => new RegExp(`^${tag} (OK|NO|BAD)`, "m").test(buf));
      if (new RegExp(`^${tag} `, "m").test(buf)) return buf;
      return `${buf}${isClosed() ? "<closed>" : "<no reply>"}`;
    },
    close: () => socket.destroy(),
  };
}

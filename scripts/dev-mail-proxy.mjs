#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dev only: the webmail on its own port (WEBMAIL_DEV_PORT, default 43300). Console and webmail are one Next app
 * (ADR-0003); this forwards HTTP and WebSocket (HMR) traffic to it unchanged, keeping the Host header, so host
 * routing (apps/web/src/server/host-routing.ts) sees the webmail port and serves the webmail. Production uses
 * separate hostnames (app.* / mail.*) instead.
 *
 * It also sets X-Forwarded-For (`dev-forwarded-for.mjs`), as NGINX does in production, so rate limits and the mail
 * server's failed-login bans count each visitor rather than the forwarder.
 */
import http from "node:http";
import net from "node:net";

import { forwardedFor } from "./dev-forwarded-for.mjs";

if (process.env.WEBMAIL_DEV_PORT === undefined) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // defaults below
  }
}
const listenPort = Number(process.env.WEBMAIL_DEV_PORT ?? "43300");
const targetPort = Number(process.env.WEB_DEV_PORT ?? "43200");
const host = process.env.DEV_HOST ?? "0.0.0.0";

/** The request's headers with X-Forwarded-For set for the visitor (never passed through from LAN clients). */
const withForwardedFor = (req) => ({
  ...req.headers,
  "x-forwarded-for": forwardedFor(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
});

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: withForwardedFor(req) },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Webmail dev server is starting — retry in a moment.");
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(targetPort, "127.0.0.1", () => {
    const headers = Object.entries(withForwardedFor(req))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(listenPort, host, () => {
  console.log(`webmail dev port ${host}:${listenPort} -> 127.0.0.1:${targetPort}`);
});

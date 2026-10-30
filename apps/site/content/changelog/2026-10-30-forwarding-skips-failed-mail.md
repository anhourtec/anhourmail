---
title: Forwarding skips mail that fails its sender's checks
date: 2026-10-30
summary: Mail that fails its sender's domain checks stays in your inbox instead of being forwarded.
---

- **Safer forwarding.** When a message fails its sender's domain checks (it may only pretend to come from that
  domain), we no longer forward it. The same goes for mail from outside that claims to come from your own domain
  when we can't confirm it did. It still arrives in your inbox as usual, and other mail is forwarded as before.
  Forwarding you already set up gets this automatically. See
  [Forwarding](/docs/webmail-settings#forwarding).

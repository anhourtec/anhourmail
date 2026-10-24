---
title: Domain checks now confirm your DKIM keys
date: 2026-10-24
summary: A custom domain only becomes active once the DKIM keys its records point to answer in DNS.
---

- **DKIM is checked end to end:** besides each DKIM record itself, the console now looks up the signing key it points
  to. A domain stays pending until every key answers, so mail from it is never sent with a signature receivers can't
  check.
- **Clear status per record:** a DKIM record whose key isn't found says "DKIM not found in DNS — mail will fail DKIM".

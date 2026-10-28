---
title: DKIM keys are now TXT records you copy from the console
date: 2026-10-28
summary: Custom domains publish their own DKIM keys as TXT records, so mail is signed with a key receivers can find.
---

- **Fixed: DKIM failed for custom domains.** The console asked for DKIM CNAME records pointing at keys that were
  never published, so receivers reported "no key for signature". DKIM is now two TXT records, one per signing key
  (RSA and Ed25519), with your domain's real public keys and a copy button for each.
- **Keys appear after the first records:** once the ownership and MX records are found, your domain's DKIM keys are
  created and shown within a minute. Add them, then check again; the domain becomes active when every key matches.
- **Clear status per key:** each DKIM record says whether it's missing or holds a different key than yours.
- **Already connected a domain?** Open it under **Domains**: the DKIM records show your keys. Replace the old DKIM
  CNAME records with these TXT records.

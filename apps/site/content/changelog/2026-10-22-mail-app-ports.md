---
title: Encrypted mail app ports only
date: 2026-10-22
summary: The mail app settings now list only the encrypted ports we offer.
---

- **Incoming mail:** IMAP on port 993 and POP3 on port 995, both with SSL/TLS. We don't list or offer the older
  upgrade-in-place ports for IMAP (143) and POP3 (110) on the hosted service.
- **Outgoing mail:** unchanged. SMTP on port 465 with SSL/TLS, or port 587 with STARTTLS for apps that insist on it.
- If a mail app was set up by hand with port 143 or 110, change it to 993 (IMAP) or 995 (POP3) with SSL/TLS. The
  [mail app settings](/docs/clients/imap-smtp-settings) page has every value with a copy button.

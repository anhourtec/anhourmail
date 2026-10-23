---
title: Mailbox passwords
date: 2026-10-23
summary: Give a mailbox its password when you create it, change your own in the webmail, and let an admin set a new one when it's forgotten.
---

- **A password at creation.** New mailboxes get the password their person signs in to the webmail with: type one or
  generate a strong one and copy it (it's shown only once). We never store mailbox passwords, only a one-way hash
  that the mail server keeps.
- **Change your own** in the webmail under **Settings → Account → Password**. You stay signed in there; the webmail
  signs out everywhere else. App passwords keep working.
- **Set a new password** for someone who forgot theirs, from the mailbox's **Password** tab in the console (owners
  and user admins; an owner's or admin's mailbox needs an owner). The console asks you to confirm it's you, the
  person is emailed, and it's in the audit log.

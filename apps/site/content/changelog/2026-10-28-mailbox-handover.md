---
title: Safer mailbox handovers
date: 2026-10-28
summary: An admin's new mailbox password can't be overridden with the old one, and a failed one is shown so it can be set again.
---

- **An admin's new password comes first.** While a password an owner or admin set for a mailbox is on its way to the
  mail server, the mailbox can't change its own password with the previous one. See
  [Set a new password](/docs/mailboxes#set-a-new-password).
- **No reset emails into a mailbox that is changing hands.** After **Make this a user**, a "Forgot password" request
  for the new person's console login sends no email until they've chosen their own mailbox password. See
  [Make a shared address a user](/docs/mailboxes#make-a-shared-address-a-user).
- **A password that didn't apply is shown.** If a new mailbox password couldn't reach the mail server, the mailbox's
  **Password** tab says so, so you can set it again.

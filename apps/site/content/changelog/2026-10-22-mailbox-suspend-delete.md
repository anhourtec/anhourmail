---
title: Suspend, delete and restore mailboxes
date: 2026-10-22
summary: Suspend a mailbox without losing anything, and delete one with a grace period during which it can be restored.
---

- **Suspend and resume:** a suspended mailbox can't be signed in to from webmail or mail apps, and mail sent to it or
  its aliases bounces. Nothing in it is deleted, and resuming turns everything back on.
- **Delete with a grace period:** a deleted mailbox is suspended straight away, keeps its mail, and keeps its address
  and its aliases' addresses reserved. The console shows the date until which it can be restored; after that it's
  permanently deleted with its aliases and mail.
- **Restore:** bring a deleted mailbox back, aliases and mail included, any time before that date.
- Aliases can't point at a mailbox that is being deleted.

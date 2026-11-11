---
title: New accounts send to AnhourMail addresses first
date: 2026-11-11
summary: A new account sends to addresses hosted on AnhourMail, from the webmail and from mail apps, until it is established.
---

- **Sending from a new account.** From the first minute a new account can send to addresses hosted on AnhourMail.
  Sending elsewhere, and from mail apps over SMTP, opens automatically once the account is established, and straight
  away on a paid plan. The webmail says so before anything is sent; a mail app that sends over JMAP gets outside
  recipients back as not delivered. See [Sending limits](/docs/sending-limits#new-accounts).
- **See your sending level.** The console's home page has a **Sending** card for each account, with its level and
  limits, and the webmail shows the open mailbox's level under **Settings → Account → Sending**. While the account is
  new, both say what opens later; **App passwords** says that mail apps can't send yet.
- **Clearer messages when a send is refused.** The composer says what to do for each case: a new account's send lists
  the recipients that may be outside AnhourMail so you can remove them and send to the rest, a paused mailbox shows
  where to write, and a used-up limit or a check that couldn't run keeps your draft. See
  [Sending limits](/docs/sending-limits#when-the-webmail-cant-send).

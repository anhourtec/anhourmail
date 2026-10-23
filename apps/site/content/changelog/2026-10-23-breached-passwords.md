---
title: Breached passwords are refused
date: 2026-10-23
summary: New passwords are checked against known data breaches without your password ever leaving our server, password fields are easier to read, and names stay names.
---

- **Breached passwords are refused.** When you sign up, reset your password, join from an invite, create a mailbox,
  claim a free address, set a mailbox password or change yours in the webmail, a password that has appeared in a known
  data breach is refused with "This password has appeared in a data breach. Choose a different one."
- **Your password stays with us.** Our server sends only the first 5 characters of a one-way hash of the new password
  to the Pwned Passwords service and compares the answer itself. Your browser never contacts it. See
  [Sign-in security](/docs/sign-in-security#passwords-seen-in-data-breaches).
- **Roomier password fields.** New-password fields now use the full width, with **Generate a strong password** on its
  own row below, so what you type stays readable next to password-manager icons in side panels and on phones.
- **Names stay names.** First, last and display names can't contain web addresses, `@`, or hidden control or
  text-direction characters, and invite emails now show the account and inviter names as quoted labels.

---
title: Password first, then your passkey
date: 2026-10-31
summary: The console always asks for your password first; a passkey is now your second step, and "Confirm it's you" asks only for your password.
---

- **Password first, every time.** Sign in to the console with your email and password. If you have a passkey, the
  console then asks you to **Use your passkey**; with an authenticator app, it asks for a code. Recovery codes still
  work on the second step if you lose your app. The **Sign in with a passkey** button is gone: a passkey no longer
  signs you in on its own. **Trust this browser** works on the passkey step too. See
  [Sign-in security](/docs/sign-in-security#the-second-step).
- **Recovery codes with a passkey.** Your first passkey now comes with recovery codes, so you can still sign in if you
  lose it. Added a passkey earlier? Choose **Create recovery codes** on your Security page. See
  [Recovery codes](/docs/sign-in-security#recovery-codes).
- **Confirm it's you with your password.** Before sensitive actions (app passwords, mailbox passwords, adding a
  passkey, mailbox access, exports and deletion), the console asks for your console password only, however you signed
  in. See [Confirm it's you](/docs/sign-in-security#confirm-its-you).
- **Sign in again once.** If you signed in with a passkey alone before this change, you're asked to sign in again
  with your password, then your passkey.
- **Removing passkeys asks for your password.** Removing a passkey (or all of them) needs your console password from
  the last few minutes, and we email you and your account's Owners when every passkey is removed.
- **Fixed:** someone with a passkey who entered their correct password to confirm an action was told to sign in again
  with their passkey. The password now works.

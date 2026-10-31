# ADR-0028: Console sign-in is password first; passkeys are a second factor; step-up is the password

**Status:** Accepted 2026-10-31 (amended the same day: recovery codes for passkey-only people, "Trust this browser"
on the passkey step, the lockout note; security review follow-ups, decision 6)

**Maintainer decisions (2026-10-31):** the console signs in the conventional cloud-console way: email and password
first, always, then a second step for anyone who has a second factor. A passkey is a **second factor**, not a
passwordless sign-in. "Confirm it's you" (step-up) before sensitive actions asks for the **console password only**.

- Related: ADR-0016 (security baseline: TOTP, passkeys, recovery codes), ADR-0023 (support access needs a fresh
  step-up), ADR-0024 (webmail handoff step-up), ADR-0020 and ADR-0025 (step-up before app passwords, exports and
  deletion); `../07-security.md` "Sign-in factors"; `packages/adapters/src/auth/security-plugin.ts`,
  `packages/core/src/security/rules.ts`, `apps/web/src/app/(console)/sign-in/sign-in-form.tsx`,
  `apps/web/src/components/security/step-up-form.tsx`.

## Context

Until now the sign-in page offered "Sign in with a passkey" as a complete sign-in on its own (discoverable
credential, no password), and the second step after the password offered it again. Step-up (`POST
/api/auth/step-up`) demanded the person's strongest factor: the password only for someone with no second factor, a
current authenticator code or a recovery code for someone with one, and for someone with **only passkeys** it refused
the password with "Sign out and sign in again with your passkey, then add the new one." That message was written for
adding a passkey, but `/step-up` serves every sensitive action (suspensions, support access, app passwords, mailbox
passwords, delegation, exports, deletion), so a Global Administrator with a passkey who typed the correct console
password to suspend an account was refused and told to sign in again. The session type was never the cause: the
refusal came from the person's factors, before the password was even checked.

## Decision

1. **Password first, always.** `POST /api/auth/sign-in/email` is the only first step. Passwordless passkey sign-in is
   gone: `GET /passkey/generate-authenticate-options` and `POST /passkey/verify-authentication` answer 401
   `PASSWORD_FIRST` unless the browser holds a pending second-step challenge (the signed `two_factor` cookie the
   password step sets), and the sign-in page no longer offers a passkey button.
2. **Second step for anyone with a second factor.** After a correct password:
   - someone with an authenticator app gets the two-factor plugin's challenge as before;
   - someone with passkeys but no authenticator app gets the same challenge, issued by our security plugin (the
     session the password created is deleted, as the two-factor plugin does);
   - the answer lists the methods the person may use (`twoFactorMethods`: `passkey`, `totp`, `recovery_code`),
     leaving out any an account requirement would refuse (under a passkey requirement only `passkey`);
   - the passkey step verifies an assertion for **that person's** credential only (another person's credential is
     refused before verification, and the session the plugin creates is checked again), uses up the challenge, and
     records the session as `password+passkey`. Wrong attempts count toward the challenge's limit (5) and, when the
     person has an authenticator app, the account lockout (10 → 15 minutes), as for codes.
   - Recovery codes are the lost-factor fallback on the second step only, for **every** second factor (maintainer
     decision, 2026-10-31): a set is issued with a person's first second factor of any kind — a passkey or an
     authenticator app — and shown once. For someone whose only second factor is a passkey they live in the two-factor
     row, left unverified (it never accepts an authenticator code) with a sealed random secret; turning an
     authenticator on replaces them only when its set-up finishes (the new set waits in a verification row until the
     first code), and turning it off while a passkey stays keeps them. `POST /api/auth/recovery-codes/generate`
     (console password, `sensitive` tier) makes a new set for passkey-only people; people who added a passkey before
     this see a prompt on their Security page to create one. With no second factor left the codes count for nothing,
     and a new first factor issues a fresh set. The lost-factor path: a recovery code, else a password reset with
     "also remove all passkeys", unless an account requirement depends on the passkeys (then an Owner helps).
   - "Trust this browser" is offered on the passkey step too, the same way as on the code steps (maintainer decision,
     2026-10-31): the two-factor plugin's cookie and verification rows (`TRUSTED_DEVICE_DAYS`), so a browser trusted on
     either step is honoured by the other; for passkey-only people our plugin checks and rotates it. A passkey
     requirement still refuses a trusted browser (the passkey step is asked instead), as before.
   - A trusted browser that an account requirement wouldn't accept (a passkey requirement) now gets the passkey
     step instead of a refusal, since there is no passwordless passkey sign-in to fall back on.
   - People without a second factor sign in with the password alone; enrolment rules and account requirements are
     unchanged (`two_factor` accepts any second step, `passkey` accepts `password+passkey`; old `passkey` sessions are ended, decision 6).
3. **Step-up is the console password only.** `POST /api/auth/step-up` takes `{ password }`; a `code` is refused
   (400 `STEP_UP_PASSWORD_ONLY`). It works the same for every session type and factor mix. Kept: the 5-minute window
   (`STEP_UP_MINUTES`), the `sensitive` rate tier, wrong attempts counting toward the account lockout when there is a
   two-factor row, and a session that fails 5 step-ups being signed out. Every successful sign-in also counts as a
   step-up for 5 minutes (it proved the password).
4. **Audit:** the password step that leads to a second step is recorded (`auth.second_step_started`, meta
   `methods`); the second step's success or failure is `auth.sign_in` / `auth.sign_in_failed` with `method`
   (`password+passkey`, `password+totp`, `password+recovery_code`); a passkey attempt without a password step is
   `auth.sign_in_failed` denied `password_first`.
5. **Existing users:** every console login has a password (sign-up, invites, staff creation and the seed all set
   one; adding a passkey needs a signed-in session), so nobody is passkey-only. Checked 2026-10-31 against the code
   paths and the dev database. Sessions recorded as `passkey` before this change are ended (decision 6).

6. **Security review follow-ups (2026-10-31, same day):**
   - **Passwordless sessions end.** Sessions recorded as `passkey` (the passwordless sign-in before this ADR) are
     refused on their next request under every policy (`sessionRefusal`, `PASSWORDLESS_ENDED`): the session is ended
     and the person signs in again with the password, then the passkey. Replacement sessions never copy `passkey`, and
     a passkey requirement accepts only `password+passkey`.
   - **Registering a passkey** upgrades the session it was added in to `password+passkey` (conventional first-device
     enrolment: that session already proved the password and a fresh step-up). The upgrade is not a step-up: the
     registration uses the step-up marker up.
   - **Removing passkeys needs a fresh step-up** (the console password): removing one, and "sign out everywhere else"
     with "also remove all passkeys" (403 `step_up_required`, audited). Removing the last second factor forgets every
     trusted browser (meta `trustedDevicesForgotten`), and leftover recovery codes count for nothing until a new first
     factor issues a fresh set. When every passkey is removed (that, a password reset with the box ticked, or removing the last one), each of
     the person's accounts records `account.sign_in_factor_removed` and the person and those accounts' Owners are
     emailed.
   - **Wrong console passwords are strikes per session** on every signed-in endpoint that checks the password
     (step-up, new recovery codes, turning an authenticator on or off, new authenticator codes, changing the
     password): an atomic counter (`redisStrikes`, Redis `INCR` in one script; errors fail closed); the fifth signs
     the session out (`auth.session_revoked` reason `password_failures`). Each also counts toward the second-step
     lockout when there is a two-factor row.
   - **A signed-in authenticator code is only ever the end of a set-up**: `/two-factor/enable` writes a
     `totp-setup-<user>` marker bound to the session (30 minutes); `verify-totp` in a session without it is refused
     (`no_setup_pending`, audited), so nobody can guess against a passkey-only person's code row. Wrong codes finishing
     a set-up count toward the lockout. The new recovery-code set waits longer than the set-up window, so a finished
     set-up always replaces the old codes; a set-up past its window starts again. New passkey recovery codes are
     refused while a set-up is pending; "turn off" is refused (400) for someone with no authenticator on.
   - **Fail closed:** if deciding about the second step fails after the password created a session (any error: the factor store or the challenge write throwing, or a refusal), that session and its cookie are deleted first; a refusal is answered as it is, anything else with 503.
   - **"Don't remember me":** the console offers no "remember me" choice (every sign-in uses the standard session
     length), so the passkey step has nothing to honour; the passkey plugin's sign-in can't take it without
     re-creating the session. Revisit if the console adds the choice.
   - Refusals audited as denied: step-up while locked (`account_temporarily_locked`), a code on step-up
     (`password_only`), new passkey recovery codes for an authenticator user (`use_authenticator_codes`), with no
     second factor (`no_second_factor`) or during a set-up (`authenticator_setup_pending`).

## Consequences

- People with passkeys now type their password on every sign-in, then touch their key: one more step than before,
  in exchange for a sign-in that always proves two things.
- Step-up for someone with two-factor sign-in is weaker than before (the password alone, not a code). Accepted by the
  maintainer: the window is short and bound to the session, the session already passed the second step to exist, and
  a stolen session that guesses wrong is signed out after 5 attempts.
- A passkey-only person whose mailbox is taken over can reset the console password and remove the passkeys on the
  reset page, as before; an account requirement closes that path.
- Wrong step-up passwords count toward the second-step lockout when the person has a two-factor row (an
  authenticator app, or recovery codes kept for a passkey); a right password doesn't clear the count, only a second
  step does. Accepted by the maintainer (2026-10-31).

## Alternatives

- **Keep passwordless passkeys alongside password sign-in.** Rejected by the maintainer: one sign-in shape, matching
  the conventional console.
- **Step-up with the strongest factor (the old rule) or a passkey assertion.** Rejected: it produced the refusal
  above and a second prompt shape; the maintainer chose the password.
- **Our own WebAuthn verification for the second step.** Rejected: the passkey plugin's verification (with our user
  check before and after) is already reviewed and keeps one code path for assertions.

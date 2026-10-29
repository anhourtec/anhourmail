# ADR-0022: Profile photos stored once, re-encoded by us, served same-origin

**Status:** Accepted 2026-10-29 (updated 2026-10-29)

## Context

Every avatar was initials (the console `Avatar`, the webmail's toned squares). Rule 61 asks for one profile source
shown the same everywhere, and for avatars that are images we host, size-capped and re-encoded server-side, never
remote URLs. `auth_user.image` (better-auth's column) existed but was unused. Constraints: control-plane data, never
mail content; no third-party requests; served on our own origins (console `app.`, webmail `mail.`) with a version in
the URL so a change shows at once and an unchanged photo is cached; mailboxes without a person (shared addresses)
need their own photo.

## Decision

1. **Storage: a small `avatar` table in Postgres**, one row per owner — a person (`user_id`) or a person-less mailbox
   (`mailbox_id`), exactly one of them (`CHECK num_nonnulls(...) = 1`), each unique, `ON DELETE CASCADE`. Columns:
   the bytes (`bytea`), content type (always `image/webp`), size (≤ 256 KiB, checked by the database) and sha256.
   A stored photo is ~2–15 KB, so a table is simpler than a volume: it is in every backup and restore drill already,
   commits in the same transaction as its audit entry, needs no second store, no path handling and no cleanup of
   orphaned files, and works the same in the memory adapter. `auth_user.image` stays unused: it would invite a remote
   URL, which we never store.
2. **Re-encoding on the server with sharp** (libvips; Apache-2.0, libvips LGPL-3.0-or-later — both on the licence
   allowlist). It was already in the lockfile as Next's optional image dependency, so the shipped set barely changes
   (`@anhourmail/adapters` now depends on it directly; notices regenerated). It sits behind a core port
   (`ImageNormaliser`, adapter `@anhourmail/adapters/image`; ESLint keeps `sharp` imports in adapters). The pipeline:
   - size cap before buffering (`AVATAR.maxUploadMb`, 5 MB; the raw body, no multipart);
   - magic bytes: PNG, JPEG or WebP only, before decoding — SVG, HTML, GIF and polyglots that start as anything else
     are refused without touching the decoder;
   - decode with `failOn: "error"`, a pixel ceiling (`limitInputPixels` = max side²) against decompression bombs,
     one frame (animations refused), each side within `AVATAR.minSide`–`AVATAR.maxSide` after orientation;
   - write a **new** file: auto-oriented, centre-cropped to a 256-pixel square, WebP, with no metadata at all (EXIF,
     GPS, ICC, XMP, comments; whatever a polyglot carried after the image data is gone);
   - check the output again (a WebP within the stored cap) before storing; at most two decodes per process at once.
     The browser also crops to a square and re-encodes before sending (smaller upload, the original's metadata never
     leaves the device), but the server never relies on it.
3. **Serving:** `GET /api/avatars/:kind/:id?v=<version>` on the console origin and `/api/webmail/avatars/:kind/:id`
   on the webmail origin. The version is the first 16 hex characters of the sha256. Headers: `Content-Type:
image/webp`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
   `Cross-Origin-Resource-Policy: same-origin`, `Content-Disposition: inline`, an ETag, and `Cache-Control: private,
max-age=31536000, immutable` only when the URL names the current version (`private, no-cache` otherwise). The
   console proxy leaves `/api/avatars/*` its own CSP, like the webmail API; `route({ cache: "handler" })` keeps the
   handler's cache header (every other API answer stays `no-store`).
4. **Who sees a photo:** the person; people in an account the person is in (as a member or through a mailbox they
   own) who may see people (`member.read`) or mailboxes (`mailbox.read`); staff with `platform.accounts.read`; webmail
   sessions of a mailbox in the same account. Everyone else gets 404 (403 for someone inside the account without the
   permission). The webmail learns photos for addresses it shows through a POST lookup that only answers for mailboxes
   in the session's accounts, so it reveals nothing about other accounts.
5. **Who changes a photo:** the profile edit rule (acded1a): the person themself (`self.profile.manage`, console
   Profile page, their own person panel, or the webmail of one of their mailboxes); an admin with `member.manage` for
   a Member, an Owner for anyone else; a person who also belongs to another account only themself. A person-less
   mailbox: `mailbox.manage` (console Mailboxes panel) or the mailbox's own webmail session. A mailbox with a person
   shows the person's photo and has none of its own to change (409). No new permission.
6. **Audit:** `account.avatar_changed` / `account.avatar_removed` (a person; a person's own change copied to each of
   their accounts, like profile details) and `mailbox.avatar_changed` / `mailbox.avatar_removed`; meta holds the
   stored size and `self` / `via`, never the image or its hash. Refusals are audited as denied.
7. **Rate limit:** uploads use `avatarUpload` (20 an hour per caller, fail closed: each one is an image decode).
8. **Sync (rule 61):** an edit refreshes the page it was made on (console `router.refresh()`; the webmail updates its
   photo store at once). Across apps: the console asks `GET /api/me/avatar` when its tab is shown or focused and
   refreshes if the URL changed; the webmail re-reads its photos on focus/visibility and every five minutes.

## Alternatives considered

- **A filesystem volume:** a second thing to back up, mount in the web container and clean up; no transactional
  link to the audit entry; nothing gained at these sizes.
- **No server image library, strict validation only:** we would still be serving bytes we didn't produce (metadata,
  trailing polyglot payloads, decoder-confusing files). Rule 61 asks for server-side re-encoding.
- **`auth_user.image` as a URL:** a remote URL is exactly what we never want; a data URL in that column would put
  image bytes into every session read.

## Consequences

- The web image now loads libvips for uploads. Alpine images get sharp's prebuilt `linuxmusl` package through
  `npm ci` (no install scripts needed); Next's standalone tracing copies it. Re-check on the next image build.
- When a person-less mailbox becomes a user ("Make this a user"), its own photo row stays but is no longer shown (the
  person's is). It goes with the mailbox.
- The sender name on mail stays a separate, per-mailbox value (the JMAP identity), distinct from the person's console
  name; both UIs now say which is which (see `docs/internal/04-data-model.md` "Names").

## Update 2026-10-29 (security review)

- **Webmail changes follow the other-account rule.** A mailbox password can be reset by an admin of the mailbox's
  account, so the webmail of a person's mailbox may change that person's photo only when the person is a member of
  the mailbox's account and of no other one. Otherwise it is refused (403, audited as `denied` `other_account`; the
  webmail shows the photo with a link to the console Profile instead of the buttons). A mailbox whose person is no
  longer in its account is refused too (`not_member`).
- **Only current memberships count.** Removing someone keeps their mailboxes' owner link (`mailbox.user_id`); a
  former account no longer sees their photo (console `avatarImage`, `accountAvatars`, the webmail list, lookup and
  image), and such a mailbox shows initials. `editRefusal`'s `membershipCount` already counted memberships only.
- **Frame check:** sharp 0.35.5 reports every frame in `metadata().pages` even with `pages: 1`; the adapter now reads
  metadata without it anyway, so the check doesn't depend on that.

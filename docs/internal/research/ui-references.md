# UI references for webmail and account console

Date: 2026-10-21

## Summary

- **Console shell:** use `arhamkhnz/next-shadcn-admin-dashboard` (MIT) as the main reference. It is on the same stack as us: Next 16, React 19, Tailwind v4, current shadcn, Biome and strict TypeScript. Copy its `dashboard/layout.tsx` shell: cookie-persisted `SidebarProvider` and `SidebarInset`, a typed nav config, a `⌘K` search dialog and the TanStack Table v9 users/roles tables. Treat everything else in it as demo content.
- **Webmail 3-pane:** no single MIT project does everything we need. Start from the admin template's `/mail` screen (MIT). It already adapts the old shadcn Mail example to Next 16 and `react-resizable-panels` v4, with a collapsible sidebar, a resizable list/reader split and a mobile drawer. On top of that, use **Mail-0/Zero (MIT)** as a pattern reference for the parts the template lacks: virtualized list (`virtua`), hotkey scopes, compose and HTML body isolation.
- **Do not copy from** Bulwark (AGPL-3.0, Stalwart JMAP webmail), Inbox Zero (AGPL-3.0) or Stalwart webadmin (AGPL-3.0/SEL, archived, Rust). Look at them only as products, never at their source while writing ours.
- The official shadcn Mail example **no longer exists**. `ui.shadcn.com/examples/mail` returns 404, and `apps/v4/app/(app)/examples/` now holds only authentication, dashboard, playground, rtl and tasks. The nearest official piece is the `sidebar-09` block (nested icon rail plus inbox list).
- **Theme is not in scope.** The `iotkinect-portal` reference app already defines our design system (tokens, typography, radius, dark mode). Take only layout and component structure from these sources. Drop their theme presets, fonts and colours.

## next-shadcn-admin-dashboard

Cloned with `--depth 1` and read only. Nothing was installed or run.

| Item | Finding |
|---|---|
| Licence | MIT, © 2024 Mohammed Arham Khan |
| Last commit | 2026-10-21 (`487a741`, "chore: update deps"), so actively maintained |
| Versions | `next ^16.4.2`, `react ^19.3.1`, `tailwindcss ^4.1.5` / `@tailwindcss/postcss ^4.3.3`, `shadcn ^4.22.1` (style `radix-nova`, `radix-ui ^1.8.1`), `@tanstack/react-table ^9.3.1`, `react-resizable-panels ^4.14.8`, `zod ^4`, `zustand ^5`, Biome 2.5, React Compiler enabled |
| Size | About 36k lines of TS/TSX in 258 `.tsx` files |
| Sibling variants | Base UI, React Aria and TanStack Start versions in separate repos |

**Structure.** `src/app/(external)` is a marketing landing page. `src/app/(main)/dashboard/*` holds about 20 demo dashboards: default, CRM, finance, analytics, ecommerce, academy, logistics, patient-monitoring, infrastructure, kanban, tasks, users, roles, invoice, file-manager, calendar, profile and productivity, plus `(legacy)` v1 variants. `src/app/(main)/mail` and `src/app/(main)/chat` are standalone full-screen apps, and `src/app/(main)/auth/{v1,v2}` holds the auth pages. Elsewhere: `src/components/ui` (shadcn), `src/navigation/sidebar/sidebar-items.ts`, `src/lib/preferences`, `src/stores/preferences`, `src/server/server-actions.ts`, `src/styles/presets` and `src/proxy.disabled.ts` (the Next 16 `proxy`, a stub only).

**Mail/inbox page.** `src/app/(main)/mail/` has about 1.3k lines, 481 of which are mock data. `/dashboard/mail` only shows it in an iframe.
- `layout.tsx` uses its own `SidebarProvider` with `MailSidebar` (`collapsible="icon"`, account switcher, folder nav with badges).
- `page.tsx` is a server component. It reads the panel-size cookie and passes it to the client `MailComponent`. The cookie goes through `JSON.parse` without validation; harden that if reused.
- Desktop is a `ResizablePanelGroup` with list and reader panels, and the layout is saved to a cookie. Mobile (`useSidebar().isMobile`) swaps the reader into a vaul `Drawer`.
- Selection lives in a small zustand store. The list is grouped (Pinned/Inbox) in a `ScrollArea`.
- It is effectively a 3-pane layout: the sidebar is the first pane.
- Quality: clean, typed and accessible enough (aria-labels, sr-only drawer titles). It is a visual demo only.
  - No virtualization: every row renders as a `<button>`.
  - No keyboard shortcuts. Prev/next and reply buttons do nothing.
  - No compose dialog. Reply is an inline input.
  - It renders a mount-gated "Loading mail..." placeholder to avoid hydration mismatch.
  - The body is plain text (`whitespace-pre-wrap`). There is no HTML rendering, so nothing about sanitising or isolating message bodies.

**Shell/sidebar.** `dashboard/layout.tsx` is an async server component.
- It reads `sidebar_state` and the preference cookies, then renders `SidebarProvider`, `AppSidebar` (variant and collapsible are configurable) and `SidebarInset`.
- The header holds `SidebarTrigger`, `SearchDialog` (cmdk), layout controls, theme switcher and account switcher.
- `data-content-padding="false"` gives full-bleed pages.
- Nav is a typed discriminated union (`NavMainLinkItem | NavMainParentItem`) with badges and disabled/new-tab flags.
- This maps well onto the console (Domains, Mailboxes, Aliases, Billing, Security). The GitHub menu, support card and layout-control toggles are fluff.

**Theming.** Tailwind v4 CSS-first. `globals.css` uses `@theme inline` and `@custom-variant dark (&:is(.dark *))`, with oklch CSS variables on `:root`/`.dark`. Three presets (brutalist, soft-pop, tangerine) are switched with `:root[data-theme-preset=…]`, plus a generator script. Dark mode uses `next-themes`. Preferences are a typed registry persisted to cookie or localStorage. None of this is needed, because our tokens come from iotkinect-portal.

**Data tables.** TanStack Table v9 with a central typed feature registry (`src/lib/data-table-features.ts`). Users, roles and tasks have faceted filters, toolbar, column visibility, row selection and numbered pagination. All client-side over mock arrays. This is a good model for mailbox and alias lists. Server-side pagination would need adding.

**Auth pages.** `auth/v1` (centred card) and `auth/v2` (split layout) login/register. They use react-hook-form + zod 4 + shadcn `Field`, plus a third-party sign-in button. `onSubmit` only shows a toast. There is no auth logic, and the proxy is disabled. Usable as layout only.

**Code quality.**
- Strict TypeScript, and zero uses of `any`.
- 6 lint or TypeScript suppression comments.
- Biome is configured with husky and lint-staged.
- 137 of 258 `.tsx` files are `"use client"`. Layouts and pages are mostly server components, and the interactive leaves are client components. That is a reasonable split, but most demo pages are client-heavy.
- The `AGENTS.md` asks contributors not to modify `components/ui`.

**Demo fluff.** Roughly 80–85% of the repo is demo content: the landing page, about 20 themed dashboards with mock JSON, legacy v1 variants, chat, kanban, invoice, patient monitoring, map/topojson, FullCalendar, shiki, simple-icons, recharts and theme presets. Worth keeping: the dashboard shell, sidebar/nav config, search dialog, data-table pattern, auth layout, mail layout skeleton and some newer shadcn primitives (`field`, `input-group`, `empty`, `kbd`, `item`).

## Alternatives

| Name | Licence | Stack | Mail UI? | Quality | Use |
|---|---|---|---|---|---|
| next-shadcn-admin-dashboard (arhamkhnz) | MIT | Next 16, React 19, TW4, shadcn radix-nova, TanStack Table v9 | Yes, demo 3-pane (resizable, mobile drawer); no virtualization, shortcuts or compose | High, current, strict, no `any` | **Primary reference for console shell and mail skeleton; copy selected files with notice** |
| shadcn/ui Mail example (`examples/mail`) | MIT | Was Next + TW + resizable panels | Was yes | n/a | **Removed:** URL 404, absent from `apps/v4` at 2026-10-19 HEAD. Survives only in git history and in derivatives such as the template above |
| shadcn/ui blocks `sidebar-07` / `sidebar-09` | MIT | shadcn v4 registry (new-york-v4, radix, base, aria bases) | `sidebar-09`: nested icon rail plus inbox list in the sidebar, no reader | High, minimal | Install through the shadcn CLI into our design system. `sidebar-07` (collapse-to-icons, team switcher, nav-user) suits the console. `sidebar-09` is an alternative webmail folder rail |
| satnaing/shadcn-admin | MIT | Vite + TanStack Router (not Next) | No (chat, tasks, users, settings) | Good | Visual reference for settings sub-nav pages; framework mismatch, so little to copy |
| Mail-0/Zero (0.email) | MIT (LICENSE © 2025 Zero Email) | Now React Router 7 + Vite, TW 4.1, radix-ui, tiptap 2, `virtua`, `react-hotkeys-hook`, tRPC/React Query | Yes, full: virtualized list, thread view, tiptap compose, hotkey scopes (global, list, thread, compose, navigation), settings incl. shortcuts recorder | Mixed: feature-rich but large files (mail-list about 1.1k lines, mail-display about 1.7k), AI features woven in, built around one large provider's API; main branch last commit 2025-08-31 | Pattern reference for virtualization, hotkeys and compose; small MIT snippets may be borrowed with notice. Do not adopt its architecture |
| Inbox Zero (elie222) | AGPL-3.0 | Next + shadcn | Inbox management and AI assistant, not a classic 3-pane client | Active | **Do not copy.** Product inspiration only |
| Bulwark Webmail (bulwarkmail) | AGPL-3.0-only (plus app-store exception) | Next 16, React 19, TS, own JMAP client, for Stalwart | Yes, full JMAP webmail (threads, search, Sieve, calendar, contacts, files) | Active, young (created 2026), about 1.3k stars | **Do not copy or read source while implementing.** Closest functional analogue; useful only for product and UX comparison (running the public demo) |
| Stalwart webadmin | AGPL-3.0 / SELv1 dual | Rust + Leptos (WASM) | No (server admin) | Archived on GitHub | Not relevant to our stack |

## Recommendation

**(a) Console shell: next-shadcn-admin-dashboard, copy selectively.**
1. Install `sidebar` (and optionally `sidebar-07`) through the shadcn CLI into our app, so the primitives are styled by iotkinect-portal tokens.
2. Port these from the template, adapting them, with an MIT notice in `THIRD_PARTY_NOTICES` and a header comment in each derived file:
   - the server `layout.tsx` pattern (cookie `defaultOpen`, `SidebarInset`, header slots, full-bleed flag)
   - the typed `sidebar-items.ts` nav union
   - `nav-main` and `nav-user`
   - `search-dialog`
   - the TanStack Table v9 feature registry and table/toolbar/pagination pattern for domains, mailboxes and aliases (switch to server-side pagination)
   - the auth v2 split layout
3. Do not take: the theme presets and preferences system, `next-themes` preset logic (use ours), dashboards, landing page, chat, charts, fonts, or the `cn` npm package (use our `cn` util).

**(b) Webmail 3-pane: the template's `/mail` layout as the skeleton, Zero as the behaviour reference.**
1. Copy the layout skeleton (with MIT notice): `ResizablePanelGroup` with a cookie-persisted layout, the folder sidebar with `collapsible="icon"`, and the mobile list-then-drawer/sheet pattern. Validate the cookie with zod instead of a bare `JSON.parse`, and replace the mount gate with a CSS/SSR-safe breakpoint where possible. At 390px, prefer a full-screen route or sheet for the reader rather than a bottom drawer.
2. Write these ourselves, using Zero's MIT code as a reference:
   - **Virtualized list:** `virtua` `VList`, or `@tanstack/react-virtual`, driven by JMAP `Email/query` position and anchor windows.
   - **Hotkey scopes:** global, list, reader and compose, using `react-hotkeys-hook` or a small in-house registry, with a `?` cheat-sheet using shadcn `kbd`.
   - **Compose:** a tiptap-based editor in a dialog/sheet. Keep it minimal.
3. HTML message bodies must not follow either template. The admin template renders plain text, and Zero injects HTML into an open shadow root. For a privacy product, render sanitized HTML (DOMPurify) inside a sandboxed `iframe srcdoc` with a strict CSP, remote content blocked by default and a proxy for images loaded on opt-in.
4. Ignore Bulwark's and Inbox Zero's source entirely (AGPL). Comparing against their running UIs is fine.

**Copy vs. reference.** MIT sources (admin template, shadcn blocks, Zero) may be copied with the copyright and permission notice retained. Prefer the shadcn CLI for primitives, and copy only the composition files listed above. Everything AGPL is visual and product reference only.

## Sources

- https://github.com/arhamkhnz/next-shadcn-admin-dashboard (cloned, HEAD `487a741`, 2026-10-21)
- https://studio-admin.arhamkhnz.com (demo, linked from the README)
- https://github.com/shadcn-ui/ui (sparse clone, HEAD 2026-10-19; `apps/v4/registry/*/blocks/sidebar-07`, `sidebar-09`; `apps/v4/app/(app)/examples/`)
- https://ui.shadcn.com/examples/mail (HTTP 404 on 2026-10-21)
- https://github.com/Mail-0/Zero (LICENSE MIT; sparse clone of `apps/mail`, main branch last commit 2025-08-31)
- https://github.com/elie222/inbox-zero (LICENSE AGPL-3.0)
- https://github.com/bulwarkmail/webmail (LICENSE AGPL-3.0-only with additional permission)
- https://github.com/stalwartlabs/webadmin (README: AGPL-3.0 / SELv1; archived)
- https://github.com/satnaing/shadcn-admin (MIT)
- https://coolify.io/docs/services/bulwark and https://localtonet.com/blog/install-bulwark-webmail-docker-compose-localtonet (Bulwark stack and scope)

# Docs framework for docs.anhourmail.com

Date: 2026-10-21

Scope: choose the framework for the public user docs. Constraints are a Next.js 16 App Router / React 19 / Tailwind v4 / shadcn/ui / TypeScript strict / Biome monorepo (npm workspaces). Content lives at repo-root `docs/public/` and `docs/shared/`. Facts (hostnames, ports, plan limits, prices, DNS templates) come from `@anhourmail/shared`. Search must be local or static, with no third-party SaaS. The site needs git "last updated", "edit on GitHub", copy buttons on code and on custom rows, light/dark, a header and footer shared with the marketing site, static export, and no analytics or telemetry.

Versions, dates and peer ranges come from the npm registry (`npm view`) on 2026-10-21. Repo activity comes from the GitHub REST API on the same day. Fumadocs claims were also checked against the published 16.17.7 / 15.4.9 tarballs: exports, `.d.ts` files, and a grep for telemetry or analytics code, which found none.

## Summary

**Pick: Fumadocs** (`fumadocs-core` + `fumadocs-ui` + `fumadocs-mdx`), deployed as a Next.js 16 app at `apps/docs` with `output: 'export'`.

- It is the only candidate that is a plain Next.js 16 App Router app. Its peer ranges are `next: 16.x.x` and `react: ^19.2.0`, and its CSS is built on Tailwind v4 with a shadcn token preset. The docs app can therefore use the same `@anhourmail/ui` header and footer, the same shadcn tokens and the same toolchain as the marketing site.
- `defineDocs({ dir })` resolves against the app's working directory, so `dir: '../../docs/public'` works. MDX files are ordinary bundler modules, so `import { … } from '@anhourmail/shared'` inside MDX goes through the normal workspace resolution.
- Search is built in and self-hosted (`createFromSource` → `staticGET` + `useStaticSearch`). The index is a static JSON file that is downloaded and searched in the browser, with no SaaS.
- It is very actively maintained: a commit on 2026-10-21, 2 open issues, and several releases a week. Pin exact versions.
- **Nextra 4.6.1 is ruled out on maintenance.** The last release was 2025-12-04 and the last commit was 2026-06-23, with 329 open issues and PRs. Its content directory is also fixed to `content/` or `src/content`.
- Starlight and Docusaurus are capable but would mean a second framework (Astro, or webpack/Rspack React SPA), duplicated header and footer components, and a second styling stack.

## Comparison

| | Fumadocs | Nextra 4 | Starlight (Astro) | Docusaurus |
|---|---|---|---|---|
| Latest version (date) | core/ui **16.17.7** (2026-10-19), mdx **15.4.9** (2026-10-20) | **4.6.1** (2025-12-04) | **0.42.6** (2026-10-08) | **3.10.2** (2026-07-10). 4.0 canaries are ongoing |
| Next 16 / React 19 | Yes. Peers `next 16.x.x`, `react ^19.2.0` | Peers `next >=14`, `react >=18`. Built against Next ^16.0.7 | N/A (Astro `^7.2.10`). React only through islands | N/A (own bundler). React `^18 \|\| ^19` |
| Tailwind v4 | Native. `@import 'fumadocs-ui/css/preset.css'`, with a `shadcn.css` colour preset | Theme ships its own compiled CSS. Tailwind v4 can sit alongside | Through an Astro Tailwind integration | Plugin or manual. Not native |
| Content outside the app | **Yes.** `defineDocs({ dir })` is resolved with `path.resolve(cwd, dir)` | **No.** `content/` in the project root or `src/` only. `contentDirBasePath` sets the URL, not the disk path | Yes. Content-layer `glob({ base })` | Yes. `docs.path` can be any directory |
| Facts from a TS package in MDX | Yes. MDX ESM imports, plus components registered in `getMDXComponents` | Yes (MDX imports) | Yes (MDX imports) | Yes (MDX imports) |
| Built-in search | Built-in engine (ZBSearch, the successor to the earlier Orama integration). Static JSON index, client-side. FlexSearch static client also available | Pagefind (post-build HTML index, client-side) | Pagefind (default) | **None built in.** Official option is Algolia DocSearch; local search needs a community plugin |
| Last updated from git | `lastModified: true` (macro) or the `fumadocs-mdx/plugins/last-modified` plugin. Needs full git history | Built in (git timestamp) | `lastUpdated: true` | `showLastUpdateTime` |
| Edit link | `EditOnGitHub` / `ViewOptionsPopover githubUrl` | `docsRepositoryBase` | `editLink.baseUrl` | `editUrl` |
| Code copy button | Default on `CodeBlock`. `useCopyButton` hook is exported for custom components | Default | Default (Expressive Code) | Default |
| Light/dark | `next-themes` (shared with the marketing site) | `next-themes` | Built in | Built in |
| Static export | `output: 'export'` (official `next-static` example) | `output: 'export'`, plus a Pagefind postbuild into `out/_pagefind` | Static by default | Static by default |
| Telemetry | None in the package. Next.js CLI telemetry must be turned off with `NEXT_TELEMETRY_DISABLED=1` | None in the package. Same Next.js caveat | **Astro CLI telemetry on by default.** Set `ASTRO_TELEMETRY_DISABLED=1` | None |
| Licence | MIT | MIT | MIT | MIT |
| Maintenance (GitHub, 2026-10-21) | Commit today. 13.4k stars, 2 open issues and PRs | Last commit 2026-06-23. 13.9k stars, 329 open | Commit 2026-10-15. 9.4k stars, 37 open | Commit 2026-10-16. 66.5k stars, 430 open |
| Shared header/footer with the Next.js site | Direct. Same React tree; layout slots take our components | Direct, but the theme layout is less pluggable | Needs React islands or a duplicated `.astro` version | Needs swizzling and a duplicated version |

## Recommendation

Use Fumadocs in a new workspace `apps/docs`, with static export.

### Pin these exact versions (no `^`)

```json
{
  "dependencies": {
    "fumadocs-core": "16.17.7",
    "fumadocs-ui": "16.17.7",
    "fumadocs-mdx": "15.4.9",
    "@anhourmail/shared": "*",
    "@anhourmail/ui": "*"
  },
  "devDependencies": {
    "@types/mdx": "2.0.14"
  }
}
```

- `fumadocs-ui@16.17.7` declares an exact peer of `fumadocs-core: 16.17.7`, so upgrade the two together.
- `fumadocs-mdx@15.4.9` needs `fumadocs-core ^16.17.0`.
- Use the monorepo's existing pins for `next` (peer `16.x.x`), `react` / `react-dom` (`^19.2.0`) and `tailwindcss` (Fumadocs builds against `^4.3.3`). The current releases are next 16.4.2, react 19.3.1 and tailwindcss 4.3.3.
- Fumadocs ships several releases a week. Upgrade on purpose, in a dedicated PR.

### Minimal config sketch

`apps/docs/next.config.mjs`

```js
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },            // required for output: 'export'
  transpilePackages: ['@anhourmail/shared', '@anhourmail/ui'],
};

export default withMDX(config);
```

`apps/docs/lib/source.ts` uses the macro API, which is the current upstream default and needs no `source.config.ts`.

```ts
import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineDocs } from 'fumadocs-mdx/macro';

// Resolved against the app's cwd (apps/docs) → <repo>/docs/public
const docs = defineDocs({
  dir: '../../docs/public',
  docs: { schema: pageSchema, lastModified: true }, // git history; CI must not shallow-clone
  meta: { schema: metaSchema },
});

export const source = loader({ baseUrl: '/', source: docs.toFumadocsSource() });

export const repoEditBase =
  'https://github.com/<org>/anhourmail/blob/main/docs/public/';
```

`apps/docs/components/mdx.tsx` registers the fact components globally, so most pages need no imports.

```tsx
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { DnsRecordTable, Fact, PlanLimit, Price } from '@/components/facts';

export function getMDXComponents(components?: MDXComponents) {
  return { ...defaultMdxComponents, Fact, PlanLimit, Price, DnsRecordTable, ...components } satisfies MDXComponents;
}
```

`apps/docs/components/facts.tsx` reads only from `@anhourmail/shared`. It uses `useCopyButton` from `fumadocs-ui/utils/use-copy-button`, or the shared shadcn copy button, for a copy button on each DNS row.

```tsx
'use client';
import { dnsRecordTemplates, hosts, plans } from '@anhourmail/shared';
// <Fact k="imapHost" /> -> hosts.imapHost; <DnsRecordTable domain="example.com" /> -> one row per template, each with a copy button
```

`docs/public/setup/dns.mdx` lives at repo root, outside the app.

```mdx
---
title: Set up DNS
---
import { hosts, ports } from '@anhourmail/shared';

Point your MX record at <Fact k="mxHost" />. IMAP is `{hosts.imapHost}` on port {ports.imaps}.

<DnsRecordTable domain="example.com" />
```

`apps/docs/app/api/search/route.ts` builds a static search index (emitted at build time and fetched by the browser).

```ts
import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

export const revalidate = false;
export const { staticGET: GET } = createFromSource(source, { language: 'english' });
```

The client search dialog uses `useStaticSearch()` from `fumadocs-core/search/client` (see the upstream `examples/next-static/components/search.tsx`).

`apps/docs/app/[[...slug]]/page.tsx` adds the edit link and last-updated line.

```tsx
import { DocsBody, DocsPage, DocsTitle, EditOnGitHub, PageLastUpdate } from 'fumadocs-ui/layouts/docs/page';
// ...
<DocsPage toc={page.data.toc}>
  <DocsTitle>{page.data.title}</DocsTitle>
  <DocsBody><MDX components={getMDXComponents()} /></DocsBody>
  <EditOnGitHub href={`${repoEditBase}${page.path}`} />
  {page.data.lastModified && <PageLastUpdate date={page.data.lastModified} />}
</DocsPage>
// export const generateStaticParams = () => source.generateParams();
```

`apps/docs/app/global.css` uses Tailwind v4 and must scan content and packages outside the app.

```css
@import 'tailwindcss';
@import 'fumadocs-ui/css/shadcn.css';   /* map Fumadocs colours to the shared shadcn tokens */
@import 'fumadocs-ui/css/preset.css';
@source '../../../docs/public';
@source '../../../packages/ui/src';
```

### Notes and caveats

- **Privacy.** Use `EditOnGitHub`, not `ViewOptionsPopover`, because the popover also renders outbound shortcut links to third-party chat tools. Leave out the upstream example's `llms`, `og/takumi` and `proxy.ts` routes. Set `NEXT_TELEMETRY_DISABLED=1` in CI, the Dockerfile and `.env`. Use self-hosted fonts through `next/font/local`, since `next/font/google` makes a build-time fetch.
- **Header and footer.** Pass `@anhourmail/ui` components through `DocsLayout`'s `nav` options or the `fumadocs-ui/layouts/docs/slots/header` slot. Wrap the app in `RootProvider` from `fumadocs-ui/provider/next`; it uses `next-themes`, like the marketing site.
- **`docs/shared/`.** Put shared MDX partials and snippets there and import them by relative path from `docs/public/**`. If they also need routes, add a second `defineDocs` or a `defineCollections` with `dir: '../../docs/shared'`.
- **Last updated.** The plugin reads local git history, so the CI checkout needs `fetch-depth: 0`.
- **Static export limits.** There is no middleware or proxy, no server actions, and no ISR. Search is a downloaded JSON index, which is fine for a docs set of this size.
- **Biome.** Fumadocs generates `.source/`. Add it to `.gitignore` and Biome's ignore list.
- **Fallback.** If Fumadocs ever stalls, Starlight is the best non-Next option (Pagefind, built-in edit link and last-updated, arbitrary content dir). It would cost a separate Astro toolchain, React islands for the shared header and footer, and Astro telemetry turned off.

## Sources

- npm registry, via `npm view <pkg> version time peerDependencies license` on 2026-10-21: [fumadocs-core](https://www.npmjs.com/package/fumadocs-core), [fumadocs-ui](https://www.npmjs.com/package/fumadocs-ui), [fumadocs-mdx](https://www.npmjs.com/package/fumadocs-mdx), [nextra](https://www.npmjs.com/package/nextra), [nextra-theme-docs](https://www.npmjs.com/package/nextra-theme-docs), [@astrojs/starlight](https://www.npmjs.com/package/@astrojs/starlight), [@docusaurus/core](https://www.npmjs.com/package/@docusaurus/core), [pagefind](https://www.npmjs.com/package/pagefind)
- GitHub REST API (`/repos/{r}`, `/repos/{r}/commits`): [fuma-nama/fumadocs](https://github.com/fuma-nama/fumadocs), [shuding/nextra](https://github.com/shuding/nextra), [withastro/starlight](https://github.com/withastro/starlight), [facebook/docusaurus](https://github.com/facebook/docusaurus)
- Fumadocs docs: [Built-in search](https://fumadocs.dev/docs/headless/search/orama), [Static export](https://fumadocs.dev/docs/deploying/static), [Fumadocs MDX](https://fumadocs.dev/docs/mdx), [Next.js setup](https://fumadocs.dev/docs/mdx/next), [Collections](https://fumadocs.dev/docs/mdx/collections), [Last modified](https://fumadocs.dev/docs/mdx/last-modified), [Docs page layout](https://fumadocs.dev/docs/ui/layouts/page), [Manual installation](https://fumadocs.dev/docs/manual-installation/next)
- Fumadocs examples: [examples/next-static](https://github.com/fuma-nama/fumadocs/tree/main/examples/next-static), [examples/next](https://github.com/fuma-nama/fumadocs/tree/main/examples/next)
- Published tarballs `fumadocs-core@16.17.7`, `fumadocs-ui@16.17.7`, `fumadocs-mdx@15.4.9`: `package.json` exports and peers, `dist/macro/index.d.ts`, `dist/plugins/last-modified.d.ts`, `dist/next/index.d.ts`, and the `dir` resolution in `dist/core-*.js`
- Nextra docs: [Content directory](https://nextra.site/docs/file-conventions/content-directory), [Search](https://nextra.site/docs/guide/search)
- Starlight docs: [Site search](https://starlight.astro.build/guides/site-search/)

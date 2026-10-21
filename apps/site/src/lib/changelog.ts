// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * Changelog entries: apps/site/content/changelog/<yyyy-mm-dd>-<slug>.md with front matter.
 * Front matter is validated at build time; a bad entry fails the build instead of shipping silently.
 */
const FrontmatterSchema = z.object({
  title: z.string().min(1).max(120),
  date: z.iso.date(),
  version: z.string().max(40).optional(),
  summary: z.string().min(1).max(400),
});

export type ChangelogEntry = z.infer<typeof FrontmatterSchema> & { slug: string; body: string };

const DIR = path.join(process.cwd(), "content", "changelog");

/** Minimal front matter parser: `key: value` lines between `---` fences. Values may be quoted. */
function parse(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1]) data[kv[1]] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return { data, body: (m[2] ?? "").trim() };
}

export async function getChangelog(): Promise<ChangelogEntry[]> {
  let files: string[];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files.map(async (file) => {
      const { data, body } = parse(await readFile(path.join(DIR, file), "utf8"));
      const result = FrontmatterSchema.safeParse(data);
      if (!result.success) throw new Error(`Invalid changelog front matter in ${file}: ${result.error.message}`);
      return { ...result.data, slug: file.replace(/\.md$/, ""), body };
    }),
  );
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

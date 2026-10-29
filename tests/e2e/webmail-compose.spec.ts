// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The one composer: it always starts in rich text with the formatting toolbar, and plain text is a mode in "More
 * options" (with a confirmation before formatting is dropped). A message written with colour, alignment, a list and
 * an indent is sent to the run's own second mailbox (local delivery only; rule 19), and its source there carries
 * those styles and nothing outside the outgoing sanitiser's allow-list; the text part stays readable. Demo passwords
 * are read from the local credentials.md and never printed.
 */
import { demoPassword } from "../support/demo-credentials";
import type { Locator, Page } from "@playwright/test";

import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";

// The message frame's sandbox blocks the trace recorder's injected script (see webmail.spec.ts): no trace here.
test.use({ trace: "off" });

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  // The Next.js dev indicator (dev builds only) can sit over controls.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function messageField(composer: Locator) {
  const field = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(field).toHaveAttribute("contenteditable", "true");
  return field;
}

/** Picks an item from one of the toolbar's menus (they open in a layer outside the toolbar). */
async function toolMenu(page: Page, composer: Locator, menu: string, item: string) {
  await composer.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu", { name: menu }).getByRole("menuitemradio", { name: item, exact: true }).click();
}

/** The decoded body of the first MIME part of `type` in a raw message (quoted-printable or base64). */
function mimePart(source: string, type: string): string {
  const raw = source.replace(/\r\n/g, "\n");
  const at = raw.search(new RegExp(`^Content-Type:\\s*${type.replace("/", "\\/")}`, "im"));
  expect(at, `the message has a ${type} part`).toBeGreaterThanOrEqual(0);
  const rest = raw.slice(at);
  const split = rest.indexOf("\n\n");
  const headers = rest.slice(0, split);
  const body = rest.slice(split + 2).split(/\n--/)[0] ?? "";
  const encoding = /^Content-Transfer-Encoding:\s*(\S+)/im.exec(headers)?.[1]?.toLowerCase() ?? "7bit";
  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") {
    const bytes = body
      .replace(/=\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}

/** The CSS properties the outgoing sanitiser lets the toolbar's styles through with (`STRICT_CSS`). */
const TOOLBAR_PROPERTIES = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "text-align",
  "margin",
  "margin-left",
  "padding",
  "padding-left",
  "border",
  "text-decoration-line",
]);

test("the composer starts in rich text; plain text is a mode in More options, with a confirmation", async ({
  page,
  consoleErrors,
}) => {
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  const field = await messageField(composer);

  // No format switch in the footer; the toolbar is there from the start.
  await expect(composer.getByRole("radiogroup", { name: "Message format" })).toHaveCount(0);
  const toolbar = composer.getByRole("toolbar", { name: "Formatting" });
  for (const name of ["Undo", "Redo", "Bold", "Strikethrough", "Increase indent", "Decrease indent", "Link"]) {
    await expect(toolbar.getByRole("button", { name, exact: true })).toBeAttached();
  }
  for (const name of ["Font", "Text size", "Text colour", "Highlight", "Align"]) {
    await expect(toolbar.getByRole("button", { name, exact: true })).toHaveAttribute("aria-haspopup", "menu");
  }

  // Bold text, then Plain text mode: asked first; Cancel keeps the rich text as it is.
  await field.pressSequentially("Hello ");
  await field.press("ControlOrMeta+b");
  await field.pressSequentially("there");
  await expect(field.locator("b")).toHaveText("there");
  await composer.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Plain text mode" }).click();
  const confirm = page.getByRole("dialog", { name: "Switch to plain text?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(toolbar).toBeVisible();
  await expect(field.locator("b")).toHaveText("there");

  // Escape closes the menu, not the composer.
  await composer.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("menuitem", { name: "Plain text mode" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Plain text mode" })).toHaveCount(0);
  await expect(composer).toBeVisible();

  // Agreeing switches to plain text: the words stay, the toolbar goes, and the menu offers rich text again.
  await composer.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Plain text mode" }).click();
  await page
    .getByRole("dialog", { name: "Switch to plain text?" })
    .getByRole("button", { name: "Switch to plain text" })
    .click();
  await expect(composer.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(/^Hello there/);
  await expect(toolbar).toHaveCount(0);
  await composer.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Switch to rich text" }).click();
  await expect(toolbar).toBeVisible();
  await expect(await messageField(composer)).toContainText("Hello there");

  await composer.getByRole("button", { name: "Discard draft" }).click();
  await expect(composer).toBeHidden();
  expect(consoleErrors).toEqual([]);
});

test("colour, highlight, alignment, a list and an indent reach the recipient within the allow-list @desktop-only", async ({
  page,
  browser,
  consoleErrors,
}) => {
  test.setTimeout(120_000);
  const tag = `fmt-${Date.now().toString(36)}`;
  const me = e2eUsers().recipient;
  await signInWebmail(page, OWNER, demoPassword(OWNER));
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByLabel("To", { exact: true }).fill(`${me.address},`);
  await composer.getByLabel("Subject").fill(`Formatting ${tag}`);
  const field = await messageField(composer);

  // A red, highlighted, centred line in a serif font.
  await field.press("Home");
  await field.pressSequentially("Centred red words");
  await field.press("Shift+Home");
  await toolMenu(page, composer, "Text colour", "Red");
  await toolMenu(page, composer, "Highlight", "Yellow");
  await toolMenu(page, composer, "Font", "Serif");
  await toolMenu(page, composer, "Align", "Align centre");
  await expect(field.locator('span[style*="color: rgb(220, 38, 38)"]')).toHaveText("Centred red words");
  await expect(field.locator('[style*="text-align: center"]')).toContainText("Centred red words");
  // The Align menu shows where the line is aligned now.
  await field.press("End");
  await composer
    .getByRole("toolbar", { name: "Formatting" })
    .getByRole("button", { name: "Align", exact: true })
    .click();
  const align = page.getByRole("menu", { name: "Align" });
  await expect(align.getByRole("menuitemradio", { name: "Align centre" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(align).toHaveCount(0);

  // A bulleted list, then an indented line (undo takes the indent off, redo puts it back). Escape gave focus back
  // to the Align button: click below the text to put the caret at its end.
  const area = await field.boundingBox();
  await field.click({ position: { x: (area?.width ?? 100) - 8, y: (area?.height ?? 100) - 8 } });
  await field.press("Enter");
  await toolMenu(page, composer, "Align", "Align left");
  await composer.getByRole("button", { name: "Bulleted list" }).click();
  await field.pressSequentially("first item");
  await field.press("Enter");
  await field.press("Enter");
  await field.pressSequentially("Indented note");
  await composer.getByRole("button", { name: "Increase indent" }).click();
  await expect(field.locator('blockquote[style*="border: none"]')).toContainText("Indented note");
  await composer.getByRole("button", { name: "Undo" }).click();
  await expect(field.locator('blockquote[style*="border: none"]')).toHaveCount(0);
  await composer.getByRole("button", { name: "Redo" }).click();
  await expect(field.locator('blockquote[style*="border: none"]')).toContainText("Indented note");
  await expect(field.locator("ul li")).toHaveText("first item");

  // Closed and reopened from Drafts, it keeps its formatting.
  await expect(composer.getByText("Draft saved")).toBeVisible({ timeout: 10_000 });
  await composer.getByRole("button", { name: "Close and keep as draft" }).click();
  await expect(composer).toBeHidden();
  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("button", { name: /^Drafts/ })
    .click();
  await page
    .getByRole("listbox", { name: "Drafts messages" })
    .getByRole("option", { name: new RegExp(`Formatting ${tag}`) })
    .click();
  const draft = page.getByRole("dialog", { name: "Draft" });
  const reopened = await messageField(draft);
  await expect(reopened.locator('span[style*="color: rgb(220, 38, 38)"]').first()).toHaveText("Centred red words");
  await expect(reopened.locator('[style*="text-align: center"]')).toContainText("Centred red words");
  await expect(reopened.locator('blockquote[style*="border: none"]')).toContainText("Indented note");
  await expect(reopened.locator("ul li")).toHaveText("first item");
  await expect(draft.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  await draft.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();

  // The recipient reads it; its source carries the styles and nothing else.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await signInWebmail(reader, me.address, me.password);
  const box = reader.getByRole("searchbox", { name: "Search mail" });
  const results = reader.getByRole("listbox", { name: "Search results messages" });
  await expect(async () => {
    await box.fill(`subject:${tag}`);
    await box.press("Enter");
    await expect(results.getByRole("option", { name: new RegExp(`Formatting ${tag}`) })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 40_000 });
  await results.getByRole("option", { name: new RegExp(`Formatting ${tag}`) }).click();
  const message = reader.getByRole("region", { name: "Message" });
  await expect(message.getByRole("heading", { name: `Formatting ${tag}` })).toBeVisible();
  await message.getByRole("button", { name: "More actions" }).click();
  const [original] = await Promise.all([
    reader.waitForEvent("popup"),
    reader.getByRole("menuitem", { name: "Show original" }).click(),
  ]);
  const sourceBox = original.getByLabel("Message source");
  await expect(sourceBox).toContainText(`Formatting ${tag}`);
  const source = (await sourceBox.textContent()) ?? "";
  await original.close();

  const html = mimePart(source, "text/html");
  expect(html).toContain("color: rgb(220, 38, 38)");
  expect(html).toContain("background-color: rgb(254, 240, 138)");
  expect(html).toContain("font-family: serif");
  expect(html).toContain("text-align: center");
  // (Typing on after a styled line keeps its style, as in any editor.)
  expect(html).toMatch(/<ul><li>(?:<span style="[^"]*">)?first item(?:<\/span>)?<\/li><\/ul>/);
  expect(html).toMatch(/<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px">/);
  const declarations = [...html.matchAll(/\sstyle="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(";"));
  for (const d of declarations.filter((x) => x.trim() !== "")) {
    const prop = d.split(":")[0]?.trim() ?? "";
    expect(TOOLBAR_PROPERTIES.has(prop), `style property ${prop}`).toBe(true);
    expect(d).not.toMatch(/url\(|expression|var\(|position|@import|\\/i);
  }
  expect(html).not.toMatch(/<script|<style|\son[a-z]+=/i);

  // The text part: the words on their own lines, a dash for the item, no quote marks for the indent.
  const text = mimePart(source, "text/plain");
  expect(text).toContain("Centred red words");
  expect(text).toContain("- first item");
  expect(text).toMatch(/^Indented note\s*$/m);
  expect(text).not.toMatch(/^>/m);
  await other.close();
  expect(consoleErrors).toEqual([]);
});

test("the formatting toolbar stays inside the composer (it scrolls sideways on a phone)", async ({
  page,
  consoleErrors,
}) => {
  const me = e2eUsers().recipient;
  await signInWebmail(page, me.address, me.password);
  await page.getByRole("button", { name: "New email" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await messageField(composer);
  const toolbar = composer.getByRole("toolbar", { name: "Formatting" });
  const box = await toolbar.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(box && composerBox && box.x + box.width <= composerBox.x + composerBox.width + 1).toBe(true);
  // The page itself never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // A menu at the end of the row opens on screen.
  await toolbar.getByRole("button", { name: "Highlight", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Highlight" });
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(menuBox && viewport && menuBox.x >= 0 && menuBox.x + menuBox.width <= viewport.width).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toBeVisible();
  await composer.getByRole("button", { name: "Discard draft" }).click();
  expect(consoleErrors).toEqual([]);
});

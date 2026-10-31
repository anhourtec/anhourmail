// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Remote images in the webmail: the seeded newsletter's images stay blocked until "Load images", which sends each
 * signed image link to the image proxy and shows the answers as `data:` images inside the sandboxed frame. For a
 * verified sender "Load images" asks "Just this once" or "Always for <sender>"; "Always" adds the address to Safe
 * senders (Settings → Junk and blocked senders shows it), whose images then load by themselves in every mode, and
 * "Stop loading" removes it again (ADR-0027). A Safe senders domain loads a verified sender's images, never a forged
 * From with that domain (delivered here over SMTP, unverified). A sender that can't be verified loads once, with a
 * line saying why it can't be remembered. The person's own mail (in Sent) loads by itself, saying nothing about its
 * sender. The proxy's own outbound fetch is covered by unit tests against a local server; here the browser's request
 * to it is answered by the test, so nothing leaves this machine (rule 19).
 */
import net from "node:net";

import type { Page } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";
import { expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";
const CLUB = "news@harbour-reading.example";
const CLUB_DOMAIN = "harbour-reading.example";

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// The message frame's sandbox blocks the trace recorder's injected script (see webmail.spec.ts).
test.use({ trace: "off" });

async function signIn(page: Page) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(OWNER);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(OWNER));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/** The account id the app shows (sent with every settings change). */
async function shownAccount(page: Page): Promise<{ accountId: string; junk: Junk }> {
  const overview = await page.request.get(`${urls.webmail}/api/webmail/settings`);
  expect(overview.ok()).toBe(true);
  const { data } = (await overview.json()) as { data: { accountId: string; rules: { junk: Junk } } };
  return { accountId: data.accountId, junk: data.rules.junk };
}

type Junk = { blocked: string[]; safe: string[]; trustedOnly: boolean };

/**
 * Back to the defaults (ask, no fingerprints, the club neither safe nor blocked), so a run never depends on or leaves
 * behind a remembered sender. `safe`: entries to add to Safe senders instead.
 */
async function resetImagePreferences(page: Page, safe: string[] = []) {
  const { accountId, junk } = await shownAccount(page);
  const headers = { Origin: urls.webmail, "X-Webmail-Account": accountId };
  const res = await page.request.patch(`${urls.webmail}/api/webmail/settings/preferences`, {
    headers,
    data: { remoteImages: "ask", imageSenders: [] },
  });
  expect(res.ok()).toBe(true);
  const club = (e: string) => e === CLUB || e === CLUB_DOMAIN;
  const saved = await page.request.put(`${urls.webmail}/api/webmail/settings/junk`, {
    headers,
    data: {
      ...junk,
      blocked: junk.blocked.filter((e) => !club(e)),
      safe: [...junk.safe.filter((e) => !club(e)), ...safe],
    },
  });
  expect(saved.ok()).toBe(true);
}

/**
 * Delivers an HTML message with one remote image to the demo mailbox over SMTP, as another server would, with the
 * club's address in From — nothing vouches for it, so the webmail can't verify it (dev only: no mail leaves the
 * machine).
 */
async function deliverForged(subject: string): Promise<void> {
  const body = [
    `From: Harbour Reading Club <${CLUB}>`,
    `To: ${OWNER}`,
    `Subject: ${subject}`,
    `Message-ID: <${String(Date.now())}.forged@harbour-reading.example>`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Our picks this week.</p><img src="https://cdn.harbour-reading.example/img/logo.png" width="120" height="40" alt="Logo">',
    ".",
  ].join("\r\n");
  const lines = ["EHLO sender.test", `MAIL FROM:<${CLUB}>`, `RCPT TO:<${OWNER}>`, "DATA", body, "QUIT"];
  const replies = await new Promise<string[]>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(process.env.STALWART_SMTP_PORT ?? 25) });
    const out: string[] = [];
    let buf = "";
    let i = -1;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(out);
    };
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      buf += d;
      clearTimeout(timer);
      timer = setTimeout(() => {
        out.push(buf.trim().split("\r\n").at(-1) ?? "");
        buf = "";
        i += 1;
        if (i >= lines.length || out.some((r) => /^5\d\d /.test(r))) finish();
        else socket.write(`${lines[i] ?? ""}\r\n`);
      }, 300);
    });
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 15_000).unref();
  });
  expect(replies.some((r) => r.startsWith("250 2.0.0"))).toBe(true);
}

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });

/** Phones show an open message full screen: back to the list first. */
async function closeMessage(page: Page) {
  const close = page.getByRole("button", { name: "Close message" });
  if (await close.isVisible()) await close.click();
}

async function openSettings(page: Page, tab: RegExp) {
  await closeMessage(page);
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settingsDialog(page)).toBeVisible();
  await settingsDialog(page).getByRole("tab", { name: tab }).click();
  return settingsDialog(page).getByRole("tabpanel");
}

/** Answers the image proxy with a PNG and records each request body. */
async function fakeImageProxy(page: Page) {
  const bodies: string[] = [];
  await page.route("**/api/webmail/img", async (route) => {
    const req = route.request();
    expect(req.method()).toBe("POST");
    bodies.push(req.postData() ?? "");
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  return bodies;
}

const safeSenderSaved = (page: Page, method: "POST" | "DELETE") =>
  page.waitForResponse((r) => r.url().endsWith("/api/webmail/settings/junk/safe") && r.request().method() === method);

async function reloadInbox(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function openNewsletter(page: Page) {
  const close = page.getByRole("button", { name: "Close message" });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("listbox", { name: "Inbox messages" })
    .getByRole("option", { name: /stories set by the sea/ })
    .click();
  const reader = page.getByRole("region", { name: "Message" });
  await expect(reader.getByRole("heading", { name: "This month: stories set by the sea" })).toBeVisible();
  return reader;
}

test("remote images load through the image proxy once, or always for a verified sender", async ({
  page,
  consoleErrors,
}) => {
  const bodies = await fakeImageProxy(page);
  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/webmail/settings/preferences") && r.method() === "PATCH") patches.push(r.url());
  });
  await signIn(page);
  await resetImagePreferences(page);
  await reloadInbox(page);
  patches.length = 0;

  const reader = await openNewsletter(page);
  const notice = reader.getByRole("status").filter({ hasText: /remote images? blocked/ });
  await expect(notice).toContainText(/tracker removed/);
  // A verified sender: no explanation, and no separate remember or stop link before loading.
  await expect(notice).not.toContainText("can't confirm");
  await expect(notice.getByRole("button", { name: "Always load from this sender" })).toHaveCount(0);
  const messageFrame = reader.locator("iframe");
  await expect(messageFrame).not.toHaveAttribute("srcdoc", /src="(?:https?:|data:image\/png)/);
  // The served HTML has image links, never the image addresses.
  await expect(messageFrame).not.toHaveAttribute("srcdoc", /harbour-reading\.example\/img/);

  // "Load images" asks once or always; Escape puts the question away and focus back on the button.
  const load = notice.getByRole("button", { name: "Load images" });
  await load.click();
  const choice = notice.getByRole("group", { name: "Load images from this sender" });
  const once = choice.getByRole("button", { name: "Just this once" });
  const always = choice.getByRole("button", { name: `Always for ${CLUB}` });
  await expect(once).toBeFocused();
  await expect(always).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(choice).toHaveCount(0);
  await expect(load).toBeFocused();
  expect(bodies).toHaveLength(0);

  // Just this once: loads, remembers nothing.
  await page.keyboard.press("Enter");
  await expect(once).toBeFocused();
  await page.keyboard.press("Enter");
  const loaded = reader.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(loaded).toBeVisible();
  await expect(loaded).toContainText("1 tracker removed");
  await expect(messageFrame).toHaveAttribute("srcdoc", /src="data:image\/png;base64,/);
  await expect(messageFrame).not.toHaveAttribute("srcdoc", /src="https?:/);
  await expect(messageFrame).toHaveAttribute("srcdoc", /img-src data:;/);
  // One request per distinct image (logo, banner, two covers); the tracker is never requested.
  expect(bodies).toHaveLength(4);
  for (const b of bodies) {
    expect(b).toMatch(/^\{"token":"v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"\}$/);
    expect(b).not.toContain("track.harbour-reading");
  }
  expect(patches).toEqual([]);
  await reloadInbox(page);
  const askedAgain = await openNewsletter(page);
  const blockedAgain = askedAgain.getByRole("status").filter({ hasText: /remote images? blocked/ });
  await expect(blockedAgain).toBeVisible();

  // Always: loads and adds the address to Safe senders, so the next time the images load by themselves.
  await blockedAgain.getByRole("button", { name: "Load images" }).click();
  const saved = safeSenderSaved(page, "POST");
  await blockedAgain.getByRole("button", { name: `Always for ${CLUB}` }).click();
  const added = await saved;
  expect(added.ok()).toBe(true);
  // The browser named the message, never an address; the server read the From itself.
  expect(Object.keys(added.request().postDataJSON() as object)).toEqual(["emailId"]);
  expect(await added.json()).toMatchObject({ data: { safeSender: { kind: "address", value: CLUB }, changed: true } });
  expect(patches).toEqual([]);
  const remembered = askedAgain.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(remembered).toContainText(`Images from ${CLUB} will load, and their mail won't go to Junk.`);
  await expect(remembered.getByRole("button", { name: "Stop loading from this sender" })).toBeVisible();

  // Settings → Junk and blocked senders lists it, with what Safe senders now means.
  const junkPanel = await openSettings(page, /^Junk and blocked senders/);
  await expect(
    junkPanel.getByText("Mail from these addresses or domains is never moved to Junk, and their images load."),
  ).toBeVisible();
  await expect(junkPanel.getByRole("list", { name: "Safe senders" })).toContainText(CLUB);

  await reloadInbox(page);
  const again = await openNewsletter(page);
  const auto = again.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(auto).toBeVisible();
  await expect(again.locator("iframe")).toHaveAttribute("srcdoc", /src="data:image\/png;base64,/);

  // Stop loading asks first (it removes the address from Safe senders too), then forgets it.
  await auto.getByRole("button", { name: "Stop loading from this sender" }).click();
  const confirm = auto.getByRole("group", { name: "Stop loading images from this sender" });
  await expect(confirm).toContainText(`Stop loading images from ${CLUB}? This also removes it from Safe senders.`);
  const removed = safeSenderSaved(page, "DELETE");
  await confirm.getByRole("button", { name: "Stop loading", exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await expect(auto.getByRole("button", { name: "Always load from this sender" })).toBeVisible();
  const after = await shownAccount(page);
  expect(after.junk.safe).not.toContain(CLUB);
  await reloadInbox(page);
  const blocked = await openNewsletter(page);
  await expect(blocked.getByRole("status").filter({ hasText: /remote images? blocked/ })).toBeVisible();
  await resetImagePreferences(page);
  expect(consoleErrors).toEqual([]);
});

test("a Safe senders domain loads a verified sender's images by itself, never a forged From with that domain", async ({
  page,
  consoleErrors,
}) => {
  const bodies = await fakeImageProxy(page);
  const subject = `Forged picks ${String(Date.now())}`;
  await deliverForged(subject);
  await signIn(page);
  await resetImagePreferences(page, [CLUB_DOMAIN]);
  await reloadInbox(page);

  // The seeded newsletter's From is verified: its images load in "Always ask" without a question.
  const reader = await openNewsletter(page);
  const loaded = reader.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(loaded).toBeVisible();
  expect(bodies).toHaveLength(4);
  await expect(reader.locator("iframe")).toHaveAttribute("srcdoc", /src="data:image\/png;base64,/);
  // Stopping names the domain entry it would remove.
  await loaded.getByRole("button", { name: "Stop loading from this sender" }).click();
  await expect(loaded.getByRole("group", { name: "Stop loading images from this sender" })).toContainText(
    `Stop loading images from anyone at ${CLUB_DOMAIN}? This also removes ${CLUB_DOMAIN} from Safe senders.`,
  );
  await loaded.getByRole("button", { name: "Cancel" }).click();
  await expect(loaded.getByRole("group", { name: "Stop loading images from this sender" })).toHaveCount(0);

  // The same domain in a From nothing vouches for: blocked, with the reason, and nothing fetched.
  await closeMessage(page);
  const box = page.getByRole("searchbox", { name: "Search mail" });
  await box.fill(`subject:${subject}`);
  await box.press("Enter");
  await page
    .getByRole("listbox", { name: "Search results messages" })
    .getByRole("option", { name: new RegExp(subject) })
    .first()
    .click();
  const forged = page.getByRole("region", { name: "Message" });
  const notice = forged.getByRole("status").filter({ hasText: /remote image blocked/ });
  await expect(notice).toContainText(
    `We can't confirm this message came from ${CLUB_DOMAIN}, so we'll ask again next time.`,
  );
  await expect(forged.locator("iframe")).not.toHaveAttribute("srcdoc", /src="data:image\/png/);
  expect(bodies).toHaveLength(4);
  // Its notice offers no way to remember it.
  await notice.getByRole("button", { name: "Load images" }).click();
  await expect(forged.getByRole("button", { name: /Just this once|Always for/ })).toHaveCount(0);
  await expect(forged.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" })).toBeVisible();
  await expect(forged.getByRole("button", { name: /from this sender/ })).toHaveCount(0);
  // Out of the Inbox again, so runs don't pile up (Trash empties itself).
  await forged.getByRole("button", { name: "Delete", exact: true }).click();
  await resetImagePreferences(page);
  expect(consoleErrors).toEqual([]);
});

test("a sender that can't be verified loads once and says why it isn't remembered", async ({ page, consoleErrors }) => {
  const bodies = await fakeImageProxy(page);
  // The seeded newsletter is verified; serve its view as the server does for an unverified From (no sender key).
  await page.route("**/api/webmail/messages/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const json = (await res.json()) as { data?: { from?: { email: string }[]; senderKey?: unknown } };
    if (json.data?.from?.[0]?.email === CLUB) {
      json.data.senderKey = null;
      Object.assign(json.data, { senderVerified: false, safeSender: null });
    }
    await route.fulfill({ response: res, json });
  });
  await signIn(page);
  await resetImagePreferences(page);
  await reloadInbox(page);

  const reader = await openNewsletter(page);
  const notice = reader.getByRole("status").filter({ hasText: /remote images? blocked/ });
  await expect(notice).toContainText(
    "We can't confirm this message came from harbour-reading.example, so we'll ask again next time.",
  );
  await expect(notice.locator(".font-mono")).toHaveText("harbour-reading.example");
  await notice.getByRole("button", { name: "Load images" }).click();
  // No question and no remember option: it loads straight away.
  const loaded = reader.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(loaded).toBeVisible();
  await expect(reader.getByRole("button", { name: /Just this once|Always for/ })).toHaveCount(0);
  await expect(loaded.getByRole("button", { name: /from this sender/ })).toHaveCount(0);
  await expect(loaded).toContainText("so we'll ask again next time");
  expect(bodies).toHaveLength(4);
  expect(consoleErrors).toEqual([]);
});

test("your own sent mail loads its images by itself, without asking about its sender", async ({
  page,
  consoleErrors,
}) => {
  const bodies = await fakeImageProxy(page);
  // A seeded Sent message is plain text: serve it as the server would a reply quoting a remote image (an outside
  // address's message), with no sender key, as our Sent copies have. The newsletter in the Inbox gets a forged own
  // From: it isn't in Sent, so it stays unverified.
  await page.route("**/api/webmail/messages/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const json = (await res.json()) as { data?: { subject?: string; from?: { email: string }[] } };
    if (json.data?.subject === "Block party set-up") {
      Object.assign(json.data, {
        html: '<p>Count me in for set-up.</p><blockquote type="cite"><img data-am-blocked="1" data-am-img="v1.1.sent.image" alt="Poster" width="60" height="20"></blockquote>',
        blockedImages: 1,
        loadableImages: 1,
        blockedTrackers: 0,
        senderKey: null,
        senderVerified: false,
        safeSender: null,
      });
    } else if (json.data?.from?.[0]?.email === CLUB) {
      json.data.from[0].email = OWNER;
      Object.assign(json.data, { senderKey: null, senderVerified: false, safeSender: null });
    }
    await route.fulfill({ response: res, json });
  });
  await signIn(page);
  await resetImagePreferences(page);
  await reloadInbox(page);

  // Found by search (Sent fills up with test runs' mail): it's in the Sent folder wherever it is opened from.
  const box = page.getByRole("searchbox", { name: "Search mail" });
  await box.fill(`from:${OWNER} subject:Block party set-up`);
  await box.press("Enter");
  await page
    .getByRole("listbox", { name: "Search results messages" })
    .getByRole("option", { name: /Block party set-up/ })
    .first()
    .click();
  const reader = page.getByRole("region", { name: "Message" });
  // In "Always ask", with nothing clicked: loaded through the proxy, once, with no question or remember option.
  const loaded = reader.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(loaded).toBeVisible();
  await expect(reader.locator("iframe")).toHaveAttribute("srcdoc", /src="data:image\/png;base64,/);
  expect(bodies).toHaveLength(1);
  await expect(reader.getByRole("button", { name: /Just this once|Always for|Load images/ })).toHaveCount(0);
  await expect(loaded.getByRole("button", { name: /from this sender/ })).toHaveCount(0);
  await expect(loaded).not.toContainText("can't confirm");
  await expect(loaded).not.toContainText("ask again");

  // An Inbox message forging the person's own address is still someone else's: it asks, and says it can't be confirmed.
  await reloadInbox(page);
  const forged = await openNewsletter(page);
  await expect(forged.getByRole("status").filter({ hasText: /remote images? blocked/ })).toContainText(
    "We can't confirm this message came from demo-family.test, so we'll ask again next time.",
  );
  expect(bodies).toHaveLength(1);
  expect(consoleErrors).toEqual([]);
});

test("Reading settings point to Safe senders for images", async ({ page, consoleErrors }) => {
  await signIn(page);
  const reading = await openSettings(page, /^Reading/);
  await expect(reading).toContainText("Images from your Safe senders always load.");
  await reading.getByRole("button", { name: "Manage them in Junk and blocked senders" }).click();
  const junk = settingsDialog(page).getByRole("tabpanel");
  await expect(junk.getByRole("list", { name: "Safe senders" }).or(junk.getByText("None yet.").first())).toBeVisible();
  await expect(junk.getByRole("heading", { name: "Safe senders" })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

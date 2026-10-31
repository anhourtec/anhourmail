// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Remote images in the webmail: the seeded newsletter's images stay blocked until "Load images", which sends each
 * signed image link to the image proxy and shows the answers as `data:` images inside the sandboxed frame. For a
 * verified sender "Load images" asks "Just this once" or "Always for <sender>"; "Always" remembers the sender, and
 * "Stop loading" forgets it. A sender that can't be verified loads once, with a line saying why it can't be
 * remembered. The person's own mail (in Sent) loads once with neither the question nor that line. The proxy's own
 * outbound fetch is covered by unit tests against a local server; here the browser's request to it is answered by the
 * test, so nothing leaves this machine (rule 19).
 */
import type { Page } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";
import { expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";
const CLUB = "news@harbour-reading.example";

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

/** Back to the defaults (ask, nobody remembered), so a run never depends on or leaves behind a remembered sender. */
async function resetImagePreferences(page: Page) {
  const overview = await page.request.get(`${urls.webmail}/api/webmail/settings`);
  expect(overview.ok()).toBe(true);
  const { data } = (await overview.json()) as { data: { accountId: string } };
  const res = await page.request.patch(`${urls.webmail}/api/webmail/settings/preferences`, {
    headers: { Origin: urls.webmail, "X-Webmail-Account": data.accountId },
    data: { remoteImages: "ask", imageSenders: [] },
  });
  expect(res.ok()).toBe(true);
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

const preferencesSaved = (page: Page) =>
  page.waitForResponse(
    (r) => r.url().endsWith("/api/webmail/settings/preferences") && r.request().method() === "PATCH",
  );

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
  // A verified sender: no explanation, and no separate remember link before loading.
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

  // Always: loads and remembers the sender, so the next time the images load by themselves.
  await blockedAgain.getByRole("button", { name: "Load images" }).click();
  const saved = preferencesSaved(page);
  await blockedAgain.getByRole("button", { name: `Always for ${CLUB}` }).click();
  expect((await saved).ok()).toBe(true);
  const remembered = askedAgain.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(remembered.getByRole("button", { name: "Stop loading from this sender" })).toBeVisible();
  await reloadInbox(page);
  const again = await openNewsletter(page);
  const auto = again.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(auto).toBeVisible();

  // Forget it again (also leaves the demo mailbox as it was).
  const forgot = preferencesSaved(page);
  await auto.getByRole("button", { name: "Stop loading from this sender" }).click();
  expect((await forgot).ok()).toBe(true);
  await expect(auto.getByRole("button", { name: "Always load from this sender" })).toBeVisible();
  await reloadInbox(page);
  const blocked = await openNewsletter(page);
  await expect(blocked.getByRole("status").filter({ hasText: /remote images? blocked/ })).toBeVisible();
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
      Object.assign(json.data, { senderVerified: false });
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

test("your own sent mail keeps images blocked until loaded, without asking about its sender", async ({
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
      });
    } else if (json.data?.from?.[0]?.email === CLUB) {
      json.data.from[0].email = OWNER;
      Object.assign(json.data, { senderKey: null, senderVerified: false });
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
  const notice = reader.getByRole("status").filter({ hasText: /remote image blocked/ });
  await expect(notice).toBeVisible();
  await expect(notice).not.toContainText("can't confirm");
  await expect(notice).not.toContainText("ask again");
  expect(bodies).toHaveLength(0);
  // Load images loads straight away (through the proxy, once): no question, no remember option.
  await notice.getByRole("button", { name: "Load images" }).click();
  const loaded = reader.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(loaded).toBeVisible();
  await expect(reader.getByRole("button", { name: /Just this once|Always for/ })).toHaveCount(0);
  await expect(loaded.getByRole("button", { name: /from this sender/ })).toHaveCount(0);
  await expect(loaded).not.toContainText("can't confirm");
  await expect(reader.locator("iframe")).toHaveAttribute("srcdoc", /src="data:image\/png;base64,/);
  expect(bodies).toHaveLength(1);

  // An Inbox message forging the person's own address is still someone else's: it says it can't be confirmed.
  await reloadInbox(page);
  const forged = await openNewsletter(page);
  await expect(forged.getByRole("status").filter({ hasText: /remote images? blocked/ })).toContainText(
    "We can't confirm this message came from demo-family.test, so we'll ask again next time.",
  );
  expect(consoleErrors).toEqual([]);
});

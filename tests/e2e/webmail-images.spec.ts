// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Remote images in the webmail: the seeded newsletter's images stay blocked until "Load images", which sends each
 * signed image link to the image proxy and shows the answers as `data:` images inside the sandboxed frame; "Always
 * load from this sender" remembers the sender, and "Stop loading" forgets it. The proxy's own outbound fetch is
 * covered by unit tests against a local server; here the browser's request to it is answered by the test, so nothing
 * leaves this machine (rule 19).
 */
import type { Page } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";
import { expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";

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

test("remote images load through the image proxy on request, and per sender", async ({ page, consoleErrors }) => {
  const bodies: string[] = [];
  await page.route("**/api/webmail/img", async (route) => {
    const req = route.request();
    expect(req.method()).toBe("POST");
    bodies.push(req.postData() ?? "");
    await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  await signIn(page);
  await resetImagePreferences(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });

  const reader = await openNewsletter(page);
  const notice = reader.getByRole("status").filter({ hasText: /remote images? blocked/ });
  await expect(notice).toContainText(/tracker removed/);
  const messageFrame = reader.locator("iframe");
  await expect(messageFrame).not.toHaveAttribute("srcdoc", /src="(?:https?:|data:image\/png)/);
  // The served HTML has image links, never the image addresses.
  await expect(messageFrame).not.toHaveAttribute("srcdoc", /harbour-reading\.example\/img/);

  await notice.getByRole("button", { name: "Load images" }).click();
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

  // Remember the sender: the next time the images load by themselves.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/webmail/settings/preferences") && r.request().method() === "PATCH",
  );
  await loaded.getByRole("button", { name: "Always load from this sender" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(loaded.getByRole("button", { name: "Stop loading from this sender" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const again = await openNewsletter(page);
  const auto = again.getByRole("status").filter({ hasText: "Images loaded through our privacy proxy" });
  await expect(auto).toBeVisible();

  // Forget it again (also leaves the demo mailbox as it was).
  const forgot = page.waitForResponse(
    (r) => r.url().endsWith("/api/webmail/settings/preferences") && r.request().method() === "PATCH",
  );
  await auto.getByRole("button", { name: "Stop loading from this sender" }).click();
  expect((await forgot).ok()).toBe(true);
  await expect(auto.getByRole("button", { name: "Always load from this sender" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  const blocked = await openNewsletter(page);
  await expect(blocked.getByRole("status").filter({ hasText: /remote images? blocked/ })).toBeVisible();
  await resetImagePreferences(page);
  expect(consoleErrors).toEqual([]);
});

// SPDX-License-Identifier: AGPL-3.0-only
import { HOSTS } from "../../packages/shared/src/platform";
import { expect, linkFromMail, test, urls } from "./fixtures";

test("marketing home renders with a single h1 and no region claims", async ({ page, consoleErrors }) => {
  await page.goto(urls.site);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByText(/hosted in canada|canadian data/i)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("docs show client settings from packages/shared", async ({ page, consoleErrors }) => {
  await page.goto(`${urls.site}/docs/clients/imap-smtp-settings`);
  await expect(page.getByText(HOSTS.imap).first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("changelog and credits pages load", async ({ page }) => {
  for (const path of ["/changelog", "/credits"]) {
    const res = await page.goto(`${urls.site}${path}`);
    expect(res?.status()).toBe(200);
  }
});

test("waitlist posts same-origin through the site and answers 202", async ({ request }) => {
  const res = await request.post(`${urls.site}/api/public/waitlist`, {
    data: { email: `e2e-${Date.now()}@waitlist.test`, startedAt: Date.now() - 10_000 },
    headers: { origin: urls.site },
  });
  expect(res.status()).toBe(202);
});

test("waitlist form submits and shows the same confirmation to everyone", async ({ page, consoleErrors }) => {
  // The server drops forms submitted implausibly fast (MIN_FILL_MS): start the page clock 10 s in the past so the
  // form looks like it was shown a while ago, instead of sleeping.
  await page.clock.install({ time: Date.now() - 10_000 });
  await page.goto(`${urls.site}/waitlist?utm_source=e2e&ref=e2etest1`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Join the waitlist" }) });
  await form.getByLabel("Email address").fill(`e2e-form-${String(Date.now())}@waitlist.test`);
  await form.getByLabel("Where did you hear about us?").selectOption("hacker-news");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByText("Check your inbox to confirm.")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("waitlist form rejects an invalid address without a request", async ({ page }) => {
  await page.goto(`${urls.site}/waitlist`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Join the waitlist" }) });
  await form.getByLabel("Email address").fill("not-an-address");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter a valid email address.");
});

test("confirm page explains an expired or unknown link", async ({ page }) => {
  await page.goto(`${urls.site}/waitlist/confirm?token=not-a-real-token`);
  await expect(page.getByText("This link has expired or was already used.")).toBeVisible();
  await expect(page.getByRole("status").getByRole("link", { name: "Join the waitlist" })).toBeVisible();
});

// Needs the backend's double opt-in (confirmation email + /api/public/waitlist/confirm in apps/web): enable when
// that ships. Reads the link from Mailpit, which captures all dev mail.
test("confirm page confirms a fresh link from the email", async ({ page, request }) => {
  const email = `e2e-confirm-${String(Date.now())}@waitlist.test`;
  const res = await request.post(`${urls.site}/api/public/waitlist`, {
    data: { email, startedAt: Date.now() - 10_000 },
    headers: { origin: urls.site },
  });
  expect(res.status()).toBe(202);
  const link = await linkFromMail(request, email, /https?:\/\/\S+\/waitlist\/confirm\?token=[^\s"<]+/);
  await page.goto(link);
  await expect(page.getByText("You’re on the list.")).toBeVisible();
});

test("trust pages load", async ({ page }) => {
  for (const path of ["/transparency", "/costs"]) {
    const res = await page.goto(`${urls.site}${path}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
  }
});

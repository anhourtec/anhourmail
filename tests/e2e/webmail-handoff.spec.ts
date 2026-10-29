// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console → webmail handoff (ADR-0024): a person signed in to the console follows **Open webmail** and lands in their
 * own mailbox's inbox without typing its password. The one-time code travels only in the URL fragment and works only
 * in the browser that started the handoff: another browser is refused (and doesn't use the code up), the code works
 * once, someone else's mailbox is a 404 and a signed-out request a 401. Uses the profile photos journey's person,
 * who owns a mailbox on the mail server (scripts/e2e-fixtures.ts).
 */
import { e2eUsers, expect, SIGN_IN_TIMEOUT, signIn, test, urls } from "./fixtures";

test("Open webmail signs the person in to their own mailbox, in this browser only, once", async ({
  page,
  browser,
  request,
}, testInfo) => {
  const u = e2eUsers();
  const me = u.avatars[testInfo.project.name] ?? { person: "", mailbox: "", mailboxPassword: "" };
  await signIn(page, me.person, u.password);

  // The console link starts the handoff on the webmail origin and carries nothing.
  const start = `${urls.webmail}/api/webmail/handoff`;
  await expect(page.getByRole("link", { name: "Open webmail" }).first()).toHaveAttribute("href", start);

  // Hold the redemption back once, to try the code from another browser first.
  let handoffUrl = "";
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && f.url().includes("/handoff#")) handoffUrl = f.url();
  });
  let mintPath = "";
  page.on("request", (r) => {
    if (r.url().includes("/webmail-handoff")) mintPath = new URL(r.url()).pathname;
  });
  await page.route(`${urls.webmail}/api/webmail/handoff`, (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );
  // Followed from the console page itself, as the link does (the console continues by itself only when the browser
  // says the navigation came from our own site). The fresh sign-in counts as the step-up.
  await page.evaluate((url) => {
    window.location.assign(url);
  }, start);
  await expect.poll(() => handoffUrl, { timeout: SIGN_IN_TIMEOUT }).not.toBe("");
  const handoff = new URL(handoffUrl);
  expect(handoff.search).toBe("");
  expect(handoff.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
  // The fragment is gone from the address bar at once.
  await expect.poll(() => new URL(page.url()).hash).toBe("");

  // Another browser has no verifier for this code: refused, nothing opened, and the code is used up.
  const other = await browser.newContext();
  try {
    const stranger = await other.newPage();
    await stranger.goto(handoffUrl);
    await expect(stranger.getByText("opened in a different browser")).toBeVisible();
    await expect(stranger.getByRole("link", { name: "Sign in with your mailbox password instead" })).toBeVisible();
    expect((await other.cookies(urls.webmail)).some((c) => c.name.endsWith("am.webmail"))).toBe(false);
  } finally {
    await other.close();
  }

  // Back in the browser that started it: that code is gone too, so it starts over and the inbox opens, no password.
  await page.unroute(`${urls.webmail}/api/webmail/handoff`);
  // (A fresh load: from the same page, a fragment-only change wouldn't reload it.)
  await page.goto("about:blank");
  await page.goto(handoffUrl);
  await expect(page.getByText("has expired or was already used")).toBeVisible();
  await page.goto(`${urls.app}/`);
  await page.evaluate((url) => {
    window.location.assign(url);
  }, start);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  expect(new URL(page.url()).origin).toBe(urls.webmail);
  await expect(page.getByText(me.mailbox).first()).toBeAttached();

  // Once only: the same link again is refused (the code was used up, and its verifier cookie went with it).
  await page.goto("about:blank");
  await page.goto(handoffUrl);
  await expect(page.getByText("has expired or was already used")).toBeVisible();

  // Someone else (signed in, not in this account) can't mint for this mailbox: 404. Signed out: 401.
  expect(mintPath).toMatch(/^\/api\/accounts\/[0-9a-f-]{36}\/mailboxes\/[0-9a-f-]{36}\/webmail-handoff$/);
  const challenge = "A".repeat(43);
  const anonymous = await request.fetch(`${urls.app}${mintPath}`, {
    method: "POST",
    headers: { origin: urls.app },
    data: { challenge },
  });
  expect(anonymous.status()).toBe(401);
  const someone = await browser.newContext();
  try {
    const p2 = await someone.newPage();
    await signIn(p2, u.users.reportsReader, u.password);
    const res = await p2.request.fetch(`${urls.app}${mintPath}`, {
      method: "POST",
      headers: { origin: urls.app },
      data: { challenge },
    });
    expect(res.status()).toBe(404);
  } finally {
    await someone.close();
  }
});

test("a link to the console page from elsewhere doesn't open the mailbox by itself", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const me = u.avatars[testInfo.project.name] ?? { person: "", mailbox: "", mailboxPassword: "" };
  await signIn(page, me.person, u.password);
  let minted = 0;
  page.on("request", (r) => {
    if (r.url().includes("/webmail-handoff")) minted += 1;
  });
  // Typed or followed from another site: the browser doesn't say "same-site", so the page waits for a click.
  await page.goto(`${urls.app}/open-webmail?challenge=${"A".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "Open webmail", level: 1 })).toBeVisible();
  const button = page.getByRole("button", { name: new RegExp(me.mailbox) });
  await expect(button).toBeEnabled();
  // Not "Opening…": nothing was started on its own.
  await expect(button).toContainText(/Open$/);
  expect(minted).toBe(0);
});

test("Open webmail without a mailbox of one's own explains itself and offers the sign-in page", async ({ page }) => {
  const u = e2eUsers();
  // Staff (here a Reports Reader) hold no account membership, so there is no mailbox to open.
  await signIn(page, u.users.reportsReader, u.password);
  await page.goto(`${urls.webmail}/api/webmail/handoff`);
  await expect(page).toHaveURL(new RegExp(`^${urls.app}/open-webmail\\?challenge=`));
  await expect(page.getByRole("heading", { name: "Open webmail", level: 1 })).toBeVisible();
  await expect(page.getByText("You don't have a mailbox you can open from here.")).toBeVisible();
  const signInLink = page.getByRole("link", { name: "Sign in with your mailbox password instead" });
  await expect(signInLink).toHaveAttribute("href", `${urls.webmail}/sign-in`);
});

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail push (docs/internal/05-webmail.md "Push"): new mail shows up within the "new mail visible" budget without
 * waiting for the 30-second check, two tabs of the same mailbox share one push stream, a message read in one tab shows
 * as read in the other, and with push unavailable the 30-second check still brings new mail in.
 *
 * The open mailbox is a demo mailbox; the mail comes from this run's own mailbox (tests/e2e fixtures), sent straight
 * through the dev mail server's JMAP API so no undo-send hold sits between "sent" and "delivered" (local delivery
 * only; rule 19). The messages are deleted again at the end. Demo passwords are read from the local credentials.md
 * and never printed.
 */
import { JmapClient } from "@anhourmail/jmap-client";
import type { BrowserContext, Page, Request } from "@playwright/test";

import { demoPassword } from "../support/demo-credentials";
import { e2eUsers, expect, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

const OWNER = "owner@demo-family.test";
const STALWART = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
/** New mail visible after delivery: ≤ 2 s (05-webmail.md budgets), plus local delivery and render slack. */
const PUSH_BUDGET_MS = 3_000;

// The message frame's sandbox blocks the trace recorder's injected script (see webmail.spec.ts): no trace here.
test.use({ trace: "off" });

const jmap = (address: string, password: string) =>
  new JmapClient({
    sessionUrl: `${STALWART}/jmap/session`,
    authorization: `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`,
  });

/** Sends a plain message from the run's mailbox to `to` (an identity is made for it if it has none yet). */
async function deliver(to: string, subject: string): Promise<void> {
  const me = e2eUsers().recipient;
  const c = jmap(me.address, me.password);
  const accountId = await c.accountId();
  const ids = await c.request([["Identity/get", { accountId, ids: null }, "i"]], USING);
  const list = (ids.get("i")?.list ?? []) as { email: string }[];
  if (!list.some((i) => i.email === me.address)) {
    await c.request(
      [["Identity/set", { accountId, create: { i: { email: me.address, name: "Push test" } } }, "s"]],
      USING,
    );
  }
  await c.sendText({ from: me.address, to: [to], subject, text: "Push." });
}

/** Deletes the owner's copies of the test messages (by subject tag). */
async function cleanUp(tag: string): Promise<void> {
  const c = jmap(OWNER, demoPassword(OWNER));
  const accountId = await c.accountId();
  const res = await c.request([["Email/query", { accountId, filter: { subject: tag }, limit: 50 }, "q"]], USING);
  const ids = (res.get("q")?.ids ?? []) as string[];
  if (ids.length > 0) await c.request([["Email/set", { accountId, destroy: ids }, "d"]], USING);
}

async function signInWebmail(page: Page) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(OWNER);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword(OWNER));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

const row = (page: Page, subject: string) =>
  page.getByRole("listbox", { name: "Inbox messages" }).getByRole("option", { name: new RegExp(subject) });

/** Push streams open in a browser context now (aborted and ended ones don't count). */
function openStreams(context: BrowserContext) {
  const live = new Set<Request>();
  const isPush = (r: Request) => new URL(r.url()).pathname.endsWith("/api/webmail/push");
  context.on("request", (r) => {
    if (isPush(r)) live.add(r);
  });
  context.on("requestfailed", (r) => live.delete(r));
  context.on("requestfinished", (r) => live.delete(r));
  return () => live.size;
}

test("new mail arrives by push within the budget, and tabs share one stream and see each other's reads", async ({
  page,
  context,
  consoleErrors,
}) => {
  test.setTimeout(90_000);
  const tag = `push-${Date.now().toString(36)}`;
  const streams = openStreams(context);
  try {
    const pushed = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith("/api/webmail/push") && r.status() === 200,
    );
    await signInWebmail(page);
    const stream = await pushed;
    // A request pinning a mailbox never gets a stream: push is the session's active own mailbox only. An own pin is
    // answered "no push" (204); a shared pin naming a mailbox that isn't shared with this session is the refusal (404).
    const own = await context.request.get(stream.url(), { headers: { "x-webmail-own": OWNER } });
    expect(own.status()).toBe(204);
    const shared = await context.request.get(stream.url(), { headers: { "x-webmail-shared": OWNER } });
    expect(shared.status()).toBe(404);
    // A second tab of the same mailbox (same session): it hears the first tab's stream.
    const second = await context.newPage();
    const secondErrors: string[] = [];
    second.on("console", (m) => {
      if (m.type() === "error") secondErrors.push(m.text());
    });
    second.on("pageerror", (e) => secondErrors.push(e.message));
    await second.goto(`${urls.webmail}/`);
    await expect(second.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
    await second.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await expect.poll(streams, { timeout: 10_000 }).toBe(1);
    // No wait for the stream's "ready": a change before it is caught by the check "ready" runs.

    const subject = `Arrives ${tag}`;
    await deliver(OWNER, subject);
    const sent = Date.now();
    await page.bringToFront();
    await expect(row(page, subject)).toBeVisible({ timeout: PUSH_BUDGET_MS });
    const elapsed = Date.now() - sent;
    test.info().annotations.push({ type: "new mail visible after", description: `${String(elapsed)} ms` });
    await expect(row(second, subject)).toBeVisible({ timeout: PUSH_BUDGET_MS });
    await expect(row(second, subject)).toHaveAccessibleName(/^Unread\. /);

    // Read in the first tab: the second shows it read, without a refresh.
    await row(page, subject).click();
    const reader = page.getByRole("region", { name: "Message" });
    await expect(reader.getByRole("heading", { name: subject })).toBeVisible();
    await expect(row(second, subject)).not.toHaveAccessibleName(/^Unread\. /, { timeout: PUSH_BUDGET_MS });

    // Still one stream for both tabs.
    expect(streams()).toBe(1);
    expect(secondErrors).toEqual([]);
    await second.close();
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanUp(tag);
  }
});

test("with push unavailable, the 30-second check still brings new mail in", async ({ page, consoleErrors }) => {
  test.setTimeout(120_000);
  const tag = `nopush-${Date.now().toString(36)}`;
  let refused = 0;
  // "No push for this tab" (what a shared mailbox's tab gets): the app falls back to checking every 30 seconds.
  await page.route("**/api/webmail/push**", async (r) => {
    refused += 1;
    await r.fulfill({ status: 204 });
  });
  try {
    await signInWebmail(page);
    await expect.poll(() => refused, { timeout: 10_000 }).toBeGreaterThan(0);
    const subject = `Polled ${tag}`;
    await deliver(OWNER, subject);
    // Not before the check: the first one runs 30 s after the page's first load.
    await expect(row(page, subject)).toBeVisible({ timeout: 45_000 });
    // It asked once and then left push alone.
    expect(refused).toBe(1);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanUp(tag);
  }
});

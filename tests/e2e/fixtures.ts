// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { type APIRequestContext, expect, type Page, test as base } from "@playwright/test";

export type E2eUsers = {
  run: string;
  password: string;
  accountName: string;
  users: Record<"globalAdmin" | "reportsReader" | "supportAdmin" | "owner" | "member" | "userAdmin", string>;
  /** A mailbox of this run's own (fresh mail-server allowance per run) for webmail send/receive journeys. */
  recipient: { address: string; password: string };
  /** Per browser project: logins for the sign-in security journeys (their own account for the requirement). */
  /** Per browser project: the mailbox passwords journey's own account (owner and member). */
  passwords: Record<string, { owner: string; member: string }>;
  /** Per browser project: the mailboxes journey's own account (owner and member), with a pool of its own. */
  mailboxes: Record<string, { owner: string; member: string }>;
  /** Per browser project: the staff suspension journey's own account (its name, owner and member). */
  suspension: Record<string, { accountName: string; owner: string; member: string }>;
  /** Per browser project: the staff support access journey's account (ADR-0023): its name, id, owner and member. */
  actAs: Record<string, { accountName: string; accountId: string; owner: string; member: string }>;
  /** Per browser project: the first-sign-in password change journey's account (its Owner and verified domain). */
  firstSignIn: Record<string, { owner: string; domain: string }>;
  /** Per browser project: the profile photos journey's person and their own mailbox (on the mail server). */
  avatars: Record<string, { person: string; mailbox: string; mailboxPassword: string }>;
  /** Per browser project: the names journey's person and their own mailbox, which follows their name (rule 61). */
  names: Record<string, { person: string; mailbox: string; mailboxPassword: string }>;
  /** Per browser project: the data export and deletion journey's account (Owner, Member) and a login that leaves. */
  data: Record<string, { accountName: string; owner: string; member: string; leaver: string }>;
  /** Per browser project: the alias limits journey's Free account (its Owner, mailbox, and the day its year filled). */
  aliasLimits: Record<string, { owner: string; mailbox: string; day: string }>;
  /**
   * Per browser project: the delegation journey's account (ADR-0026) — its Owner, the person given access, a colleague
   * whose mailbox is converted to shared, a leaver who is removed, the verified domain and a shared mailbox on it.
   */
  delegation: Record<
    string,
    { owner: string; delegate: string; colleague: string; leaver: string; domain: string; shared: string }
  >;
  /**
   * Per browser project: the webmail delegation journey's account (ADR-0026 §6) — its Owner, the person given access
   * and their own mailbox (address and password), a shared mailbox (Read and manage, Send as) and one for Send on
   * behalf.
   */
  delegationWebmail: Record<
    string,
    { owner: string; delegate: string; mailbox: string; mailboxPassword: string; shared: string; team: string }
  >;
  security: Record<
    string,
    {
      totp: string;
      passkey: string;
      owner: string;
      member: string;
      pkOwner: string;
      pkMember: string;
      /** A Global Administrator of this project's own (password-first sign-in and step-up, ADR-0028). */
      admin: string;
      /** The account that admin suspends and opens with support access. */
      adminAccount: string;
    }
  >;
};

export const urls = {
  site: process.env.SITE_URL ?? "http://localhost:43100",
  app: process.env.APP_URL ?? "http://localhost:43200",
  webmail: process.env.WEBMAIL_URL ?? "http://localhost:43300",
};

export const e2eUsers = (): E2eUsers => JSON.parse(readFileSync("test-results/e2e-users.json", "utf8")) as E2eUsers;

/**
 * Fails the test on any console error, uncaught page error or Content-Security-Policy violation. Violations are
 * reported from the page itself (`securitypolicyviolation`), so they count even when the browser logs none.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    await page.exposeBinding("__reportCspViolation", (_source, text: string) => {
      errors.push(text);
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        const report = (window as unknown as { __reportCspViolation?: (text: string) => void }).__reportCspViolation;
        report?.(`CSP violation: ${e.effectiveDirective} blocked ${e.blockedURI || "inline"} on ${e.documentURI}`);
      });
    });
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await use(errors);
    expect(errors, "console errors").toEqual([]);
  },
});

/** The console home: its greeting ("Good morning, Pat"; "Hello, Pat" before the browser's clock is read). */
export const homeHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^(Hello|Good (morning|afternoon|evening)), / });

/**
 * How long to wait for the result of a sign-in. Signing in checks a password with argon2 (and, for a mailbox,
 * exchanges an OAuth code with the mail server and makes the first JMAP calls), deliberately slow work that a cold
 * CI runner can take several seconds over. Every other assertion keeps the default timeout.
 */
export const SIGN_IN_TIMEOUT = 15_000;

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${urls.app}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(homeHeading(page)).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
}

/** The open flyout details panel (a modal dialog), by its name. */
export const panel = (page: Page, name: string | RegExp) =>
  page.getByRole("dialog", typeof name === "string" ? { name, exact: true } : { name });

/** After a reload the panel is server-rendered first; once the page is interactive, focus moves into it. */
export async function panelReady(page: Page, name: string | RegExp) {
  await expect(panel(page, name).locator(":focus")).toHaveCount(1);
}

/** A domain record's status cell ("Found", "Missing"), matched exactly (not "Found instead: …"). */
export const recordStatus = (page: Page, domain: string, status: string) =>
  panel(page, domain).getByRole("region", { name: "Required records" }).getByText(status, { exact: true });

/**
 * Verifies a just-added domain from its open details panel, as a customer would: a check (ownership and MX pass, so
 * the worker adds it to the mail server and creates its DKIM keys), wait for the five records to be found, then a
 * second check. Development DNS answers for `.test` names as if every record were published.
 */
export async function verifyDomain(page: Page, domain: string) {
  await panel(page, domain).getByRole("button", { name: "Check now" }).click();
  const answer = panel(page, domain)
    .getByRole("status")
    .filter({ hasText: /Verified\.|Your DKIM keys are being created/ });
  await expect(answer).toBeVisible();
  if ((await answer.textContent())?.includes("Verified.")) return;
  await expect(async () => {
    await page.reload();
    await expect(recordStatus(page, domain, "Found")).toHaveCount(5, { timeout: 2000 });
  }).toPass({ timeout: 30_000, intervals: [2000, 3000, 5000] });
  await panelReady(page, domain);
  await panel(page, domain).getByRole("button", { name: "Check now" }).click();
  await expect(panel(page, domain).getByRole("status").filter({ hasText: "Verified." })).toBeVisible();
}

/**
 * The console navigation. On small screens it lives in a drawer behind "Open navigation", so open it first; on
 * wide screens the left navigation is always there.
 */
export async function openNav(page: Page) {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  return page.getByRole("navigation", { name: "Console" });
}

/** The app bar's search box (behind "Open search" on small screens). */
export async function openSearch(page: Page) {
  const open = page.getByRole("button", { name: "Open search" });
  if (await open.isVisible()) await open.click();
  return page.getByRole("combobox", { name: "Search the console" });
}

/** Signs out through the person's menu in the app bar. */
export async function signOut(page: Page) {
  // A click that lands before the app bar hydrates opens nothing: open it again until the menu shows.
  const item = page.getByRole("menuitem", { name: "Sign out" });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole("button", { name: "Your account", exact: true }).click();
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await item.click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

export { expect };

const mailpit = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;

/** Waits for a message to `to` in Mailpit (dev mail sink) and returns the first URL matching `pattern`. */
export async function linkFromMail(request: APIRequestContext, to: string, pattern: RegExp): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = (await (
          await request.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
        ).json()) as { messages?: { ID: string }[] };
        for (const m of search.messages ?? []) {
          const msg = (await (await request.get(`${mailpit}/api/v1/message/${m.ID}`)).json()) as { Text: string };
          link = pattern.exec(msg.Text)?.[0];
          if (link) return true;
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return link ?? "";
}

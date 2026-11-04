// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign-up proof-of-work (ADR-0031): the page solves a challenge in a Web Worker with no action from the person, the
 * sign-up carries the proof and succeeds, and the same proof sent again — or a forged one — is refused.
 */
import { e2eUsers, expect, homeHeading, test, urls } from "./fixtures";

const CHECK = '[data-testid="sign-up-check"]';

test("sign-up solves the automatic check in the browser and creates the account; a replayed or forged proof is refused", async ({
  page,
  consoleErrors,
}, testInfo) => {
  const u = e2eUsers();
  // The run prefix lets global teardown remove the user and the personal account.
  const who = `${u.run}-${testInfo.project.name}-pow`;
  await page.goto(`${urls.app}/sign-up`);
  // Starts on its own, says so, and finishes without anyone touching the page.
  await expect(page.locator(CHECK)).toBeVisible();
  await expect(page.locator(CHECK)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await expect(page.getByText("Automatic check done.")).toBeVisible();

  await page.getByLabel("First name").fill(who);
  await page.getByLabel("Email").fill(`${who}@e2e.test`);
  await page.getByLabel("Password", { exact: true }).fill(`${u.password}-pow`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/auth/sign-up/email") && r.method() === "POST");
  await page.getByRole("button", { name: "Create account" }).click();
  const request = await sent;
  const challenge = request.headers()["x-sign-up-challenge"] ?? "";
  const proof = request.headers()["x-sign-up-proof"] ?? "";
  expect(challenge).toMatch(/^v1\.\d+\.\d+\./);
  expect(proof).toMatch(/^\d+$/);
  await expect(homeHeading(page)).toBeVisible();

  // The same proof again (another address, so only the proof can be what refuses it): spent.
  const replay = (c: string, p: string, email: string) =>
    page.request.post(`${urls.app}/api/auth/sign-up/email`, {
      headers: { origin: urls.app, "x-sign-up-challenge": c, "x-sign-up-proof": p },
      data: { firstName: who, name: who, email, password: `${u.password}-pow` },
    });
  const replayed = await replay(challenge, proof, `${who}-replay@e2e.test`);
  expect(replayed.status()).toBe(400);
  expect(((await replayed.json()) as { error: { code: string } }).error.code).toBe("proof_of_work");

  // A challenge edited to be easier fails its signature.
  const parts = challenge.split(".");
  const forged = await replay([parts[0], "1", ...parts.slice(2)].join("."), "0", `${who}-forged@e2e.test`);
  expect(forged.status()).toBe(400);

  // No proof at all.
  const bare = await page.request.post(`${urls.app}/api/auth/sign-up/email`, {
    headers: { origin: urls.app },
    data: { firstName: who, name: who, email: `${who}-bare@e2e.test`, password: `${u.password}-pow` },
  });
  expect(bare.status()).toBe(400);
  expect(consoleErrors).toEqual([]);
});

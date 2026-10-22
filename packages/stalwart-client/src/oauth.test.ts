// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import { StalwartManagement } from "./management";
import {
  OAuthDeniedError,
  OAuthThrottledError,
  OAuthUnavailableError,
  pkcePair,
  StalwartOAuth,
  upsertOAuthClient,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "./oauth";

type Seen = { url: string; body: string; headers: Headers };

function fakeFetch(handler: (url: string, body: string) => Response) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url, body, headers: new Headers(init?.headers) });
    return handler(url, body);
  }) as typeof fetch;
  return { f, seen };
}

const opts = (f: typeof fetch) => ({
  baseUrl: "http://stalwart:8080/",
  clientId: WEBMAIL_OAUTH_CLIENT_ID,
  redirectUri: webmailRedirectUri("https://mail.example.test/"),
  fetch: f,
  now: () => 1_000_000,
});

describe("StalwartOAuth", () => {
  it("builds the redirect URI and a valid S256 PKCE pair", () => {
    expect(webmailRedirectUri("http://localhost:43300")).toBe("http://localhost:43300/oauth/callback");
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("signs in with the headless code flow and PKCE", async () => {
    const { f, seen } = fakeFetch((url) =>
      url.endsWith("/api/auth")
        ? Response.json({ type: "authenticated", client_code: "code-1" })
        : Response.json({ access_token: "at", refresh_token: "rt", expires_in: 60, token_type: "Bearer" }),
    );
    const t = await new StalwartOAuth(opts(f)).signIn("a@x.test", "pw");
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000 + 60_000 });
    expect(seen.map((s) => s.url)).toEqual(["http://stalwart:8080/api/auth", "http://stalwart:8080/auth/token"]);
    const auth = JSON.parse(seen[0]?.body ?? "{}") as Record<string, string>;
    expect(auth).toMatchObject({
      type: "authCode",
      accountName: "a@x.test",
      accountSecret: "pw",
      clientId: WEBMAIL_OAUTH_CLIENT_ID,
      redirectUri: "https://mail.example.test/oauth/callback",
      codeChallengeMethod: "S256",
    });
    const form = new URLSearchParams(seen[1]?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe("https://mail.example.test/oauth/callback");
    expect(
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(auth.codeChallenge);
    expect(seen[1]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("maps wrong passwords and MFA prompts to OAuthDeniedError", async () => {
    for (const res of [
      () => Response.json({ type: "failure" }),
      () => Response.json({ type: "mfaRequired" }),
      () => new Response("", { status: 401 }),
    ]) {
      const { f } = fakeFetch(() => res());
      await expect(new StalwartOAuth(opts(f)).signIn("a@x.test", "bad")).rejects.toBeInstanceOf(OAuthDeniedError);
    }
  });

  it("maps throttling and bans (429, 403) to OAuthThrottledError, never to a wrong password", async () => {
    for (const status of [429, 403]) {
      const { f } = fakeFetch(() => new Response("", { status }));
      await expect(new StalwartOAuth(opts(f)).signIn("a@x.test", "pw")).rejects.toBeInstanceOf(OAuthThrottledError);
      await expect(new StalwartOAuth(opts(f)).refresh("rt")).rejects.toBeInstanceOf(OAuthThrottledError);
    }
  });

  it("forwards the client address to both endpoints, and sends none when unknown", async () => {
    const { f, seen } = fakeFetch((url) =>
      url.endsWith("/api/auth")
        ? Response.json({ type: "authenticated", client_code: "c" })
        : Response.json({ access_token: "at", refresh_token: "rt" }),
    );
    await new StalwartOAuth(opts(f)).signIn("a@x.test", "pw", "203.0.113.5");
    await new StalwartOAuth(opts(f)).refresh("rt", "203.0.113.6");
    await new StalwartOAuth(opts(f)).refresh("rt");
    expect(seen.map((s) => s.headers.get("x-forwarded-for"))).toEqual([
      "203.0.113.5",
      "203.0.113.5",
      "203.0.113.6",
      null,
    ]);
  });

  it("maps outages and malformed answers to OAuthUnavailableError", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(new StalwartOAuth(opts(down)).signIn("a", "b")).rejects.toBeInstanceOf(OAuthUnavailableError);
    const { f: e500 } = fakeFetch(() => new Response("", { status: 500 }));
    await expect(new StalwartOAuth(opts(e500)).signIn("a", "b")).rejects.toBeInstanceOf(OAuthUnavailableError);
    const { f: noToken } = fakeFetch((url) =>
      url.endsWith("/api/auth") ? Response.json({ type: "authenticated", client_code: "c" }) : Response.json({}),
    );
    await expect(new StalwartOAuth(opts(noToken)).signIn("a", "b")).rejects.toBeInstanceOf(OAuthUnavailableError);
    const { f: tok500 } = fakeFetch(() => new Response("oops", { status: 503 }));
    await expect(new StalwartOAuth(opts(tok500)).refresh("rt")).rejects.toBeInstanceOf(OAuthUnavailableError);
  });

  it("refreshes, keeping the refresh token when none is returned, and treats invalid_grant as signed out", async () => {
    const { f, seen } = fakeFetch(() => Response.json({ access_token: "at2" }));
    const t = await new StalwartOAuth(opts(f)).refresh("rt");
    expect(t).toEqual({ accessToken: "at2", refreshToken: "rt", expiresAt: 1_000_000 + 3_600_000 });
    expect(new URLSearchParams(seen[0]?.body).get("grant_type")).toBe("refresh_token");
    const { f: denied } = fakeFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(new StalwartOAuth(opts(denied)).refresh("rt")).rejects.toBeInstanceOf(OAuthDeniedError);
  });
});

describe("upsertOAuthClient", () => {
  function server(existing: { id: string; clientId: string }[]) {
    const sets: Record<string, unknown>[] = [];
    const { f } = fakeFetch((_url, body) => {
      const { methodCalls } = JSON.parse(body) as { methodCalls: [string, Record<string, unknown>, string][] };
      const out = methodCalls.map(([name, args, id]) => {
        if (name === "x:OAuthClient/get") return [name, { list: existing }, id];
        sets.push(args);
        return [name, args.create ? { created: { c: { id: "new1" } } } : { updated: {} }, id];
      });
      return Response.json({ methodResponses: out });
    });
    const mgmt = new StalwartManagement(
      new StalwartTransport({ baseUrl: "http://s/", auth: { type: "basic", username: "a", password: "b" }, fetch: f }),
    );
    return { mgmt, sets };
  }

  it("creates the client with its redirect URIs, or updates it in place", async () => {
    const input = { clientId: "c1", description: "d", redirectUris: ["https://m/oauth/callback"] };
    const fresh = server([]);
    expect(await upsertOAuthClient(fresh.mgmt, input)).toBe("new1");
    expect(fresh.sets[0]).toMatchObject({
      create: { c: { clientId: "c1", redirectUris: { "https://m/oauth/callback": true } } },
    });
    const known = server([{ id: "o9", clientId: "c1" }]);
    expect(await upsertOAuthClient(known.mgmt, input)).toBe("o9");
    expect(known.sets[0]).toMatchObject({ update: { o9: { description: "d" } } });
  });
});

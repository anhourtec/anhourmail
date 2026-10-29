// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { log } from "@anhourmail/server/log";
import { requestContext } from "@anhourmail/server/request-context";
import {
  OAuthDeniedError,
  OAuthThrottledError,
  StalwartOAuth,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";
import { WEBMAIL_HANDOFF } from "@anhourmail/shared/webmail";

import { GrantRefusedError, type OAuthPort, type OAuthTokens, WebmailBusyError } from "../webmail/service";
import { handoffCredentials } from "./stalwart";

/**
 * The webmail's OAuth port on Stalwart (rule 21: Stalwart only through its client, behind an adapter). Maps the
 * client's "denied" error to the service's `GrantRefusedError` and throttling/bans to `WebmailBusyError` (429, never
 * "wrong password"); anything else is an outage.
 */
export function stalwartOAuthPort(opts: {
  stalwartUrl: string;
  webmailUrl: string;
  /**
   * Dev only: the address to forward when the request has none (a direct hit without a proxy, or work outside a
   * request), so Stalwart counts failures against that client and never against the app's own connection — which
   * in dev is the shared `mail-edge` forwarder. Production leaves it unset (NGINX always supplies the address).
   */
  fallbackIp?: string | null;
}): OAuthPort {
  const oauth = new StalwartOAuth({
    baseUrl: opts.stalwartUrl,
    clientId: WEBMAIL_OAUTH_CLIENT_ID,
    redirectUri: webmailRedirectUri(opts.webmailUrl),
  });
  const mapped =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn(...a);
      } catch (err) {
        if (err instanceof OAuthDeniedError) throw new GrantRefusedError("refused");
        if (err instanceof OAuthThrottledError) throw new WebmailBusyError("mail server throttling");
        throw err;
      }
    };
  // The trusted client address of the current request (set by route()), forwarded as X-Forwarded-For.
  const ip = () => requestContext()?.clientIp ?? opts.fallbackIp ?? null;
  return {
    signIn: mapped((name: string, secret: string) => oauth.signIn(name, secret, ip())),
    refresh: mapped((token: string) => oauth.refresh(token, ip())),
  };
}

/**
 * The console → webmail handoff sign-in (ADR-0024): mints a throwaway credential on the mailbox's account (operations
 * key, through the management proxy in production), exchanges it once for webmail tokens with the person's address
 * forwarded, and destroys it whatever happened. If the destroy fails, Stalwart refuses the credential after 60 s
 * anyway and the next handoff for that mailbox clears it. The secret never leaves this function.
 */
export function stalwartHandoffSignIn(opts: {
  stalwartUrl: string;
  webmailUrl: string;
  fallbackIp?: string | null;
}): (target: { address: string; externalId: string }) => Promise<OAuthTokens> {
  const oauth = new StalwartOAuth({
    baseUrl: opts.stalwartUrl,
    clientId: WEBMAIL_OAUTH_CLIENT_ID,
    redirectUri: webmailRedirectUri(opts.webmailUrl),
  });
  const ip = () => requestContext()?.clientIp ?? opts.fallbackIp ?? null;
  return async ({ address, externalId }) => {
    const credentials = handoffCredentials();
    const made = await credentials.mint(externalId, WEBMAIL_HANDOFF.credentialSec * 1000);
    try {
      return await oauth.signInWithHandoffCredential(address, made.secret, ip());
    } catch (err) {
      if (err instanceof OAuthThrottledError) throw new WebmailBusyError("mail server throttling");
      if (err instanceof OAuthDeniedError) throw new GrantRefusedError("refused");
      throw err;
    } finally {
      await credentials.destroy(externalId, made.id).catch((err: unknown) => {
        log.warn("webmail handoff: credential not destroyed (it expires within a minute)", {
          component: "webmail",
          err,
        });
      });
    }
  };
}

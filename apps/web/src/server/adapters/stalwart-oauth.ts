// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { requestContext } from "@anhourmail/server/request-context";
import {
  OAuthDeniedError,
  OAuthThrottledError,
  StalwartOAuth,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";

import { GrantRefusedError, type OAuthPort, WebmailBusyError } from "../webmail/service";

/**
 * The webmail's OAuth port on Stalwart (rule 21: Stalwart only through its client, behind an adapter). Maps the
 * client's "denied" error to the service's `GrantRefusedError` and throttling/bans to `WebmailBusyError` (429, never
 * "wrong password"); anything else is an outage.
 */
export function stalwartOAuthPort(opts: { stalwartUrl: string; webmailUrl: string }): OAuthPort {
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
  const ip = () => requestContext()?.clientIp ?? null;
  return {
    signIn: mapped((name: string, secret: string) => oauth.signIn(name, secret, ip())),
    refresh: mapped((token: string) => oauth.refresh(token, ip())),
  };
}

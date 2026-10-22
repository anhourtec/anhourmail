// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Platform,
  parsePlatformDomain,
  platformFacts,
  productionPlatformProblems,
} from "@anhourmail/shared/platform";

/**
 * This deployment's hostnames for worker processes, from `PLATFORM_DOMAIN` (unset = anhourmail.com outside
 * production). In production it refuses to start — the same checks as the web app — unless `PLATFORM_DOMAIN` is set
 * explicitly and `APP_URL` is a host directly under it, so a staging worker can't verify customer DNS against
 * production's names. Throws with every problem, naming settings only.
 */
export function workerPlatform(env: Record<string, string | undefined> = process.env): Platform {
  const domain = parsePlatformDomain(env.PLATFORM_DOMAIN);
  if (env.NODE_ENV === "production") {
    const problems = productionPlatformProblems({
      platformDomainSetting: env.PLATFORM_DOMAIN,
      domain,
      urls: { APP_URL: env.APP_URL },
    });
    if (problems.length > 0) throw new Error(`Worker configuration refused: ${problems.join("; ")}`);
  }
  return platformFacts(domain);
}

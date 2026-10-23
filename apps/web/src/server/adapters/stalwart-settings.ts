// SPDX-License-Identifier: AGPL-3.0-only
import { credentialEnvProblems } from "@anhourmail/stalwart-client";

/**
 * The web app's Stalwart settings problems (ADR-0020 "Credential split"): in production it holds the operations key
 * only — never the provisioning key (it can't create or change accounts) or the scheduler's audit key — and never the
 * dev admin; the legacy single key is refused everywhere. Names only. Checked by `env()`.
 */
export const stalwartSettingsProblems = (env: Record<string, string | undefined>): string[] =>
  credentialEnvProblems(["operations"], env);

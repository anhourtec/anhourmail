// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";

export default function globalSetup(): void {
  execFileSync("npx", ["tsx", "--env-file-if-exists=.env", "scripts/e2e-fixtures.ts", "create"], { stdio: "inherit" });
}

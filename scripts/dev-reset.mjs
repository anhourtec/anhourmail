#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/** `npm run dev:reset`: wipe dev volumes, restart the stack, migrate and seed the demo world. Dev only. */
import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
run("docker", ["compose", "--profile", "dev", "down", "--volumes"]);
run("docker", ["compose", "--profile", "dev", "up", "-d", "--wait"]);
run("npm", ["run", "db:seed", "--", "--demo"]);

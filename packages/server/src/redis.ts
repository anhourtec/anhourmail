// SPDX-License-Identifier: MIT
import { Redis } from "ioredis";

const globalForRedis = globalThis as unknown as { amRedis?: Redis };

/** The shared ioredis client (lazy; survives Next dev hot reloads). */
export function redis(): Redis {
  if (!globalForRedis.amRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    globalForRedis.amRedis = new Redis(url, { maxRetriesPerRequest: 2 });
  }
  return globalForRedis.amRedis;
}

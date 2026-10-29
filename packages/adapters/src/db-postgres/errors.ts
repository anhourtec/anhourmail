// SPDX-License-Identifier: AGPL-3.0-only

/** Postgres unique violation (23505), whether or not the driver error is wrapped. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if ((e as Error & { code?: unknown }).code === "23505") return true;
  }
  return false;
}

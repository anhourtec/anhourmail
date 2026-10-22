// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Same-origin JSON call to the console API; returns the error message (and code, e.g. `step_up_required`) from the
 * `{ error }` envelope on failure.
 */
export async function callApi(
  url: string,
  init: { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string; code?: string }> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: unknown;
      error?: { message?: string; code?: string };
    } | null;
    if (res.ok) return { ok: true, data: json?.data };
    return {
      ok: false,
      status: res.status,
      message: json?.error?.message ?? "Something went wrong. Try again.",
      ...(json?.error?.code ? { code: json.error.code } : {}),
    };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach the server. Check your connection." };
  }
}

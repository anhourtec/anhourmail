// SPDX-License-Identifier: MIT
/**
 * Low-level JMAP transport for Stalwart's management API (`POST /jmap`, capability `urn:stalwart:jmap`).
 * Collections in Stalwart's JSON encoding: List<T> is an object keyed "0", "1", …; Set<T> is { member: true };
 * durations are milliseconds and sizes are bytes.
 */

export type StalwartAuth = { type: "basic"; username: string; password: string } | { type: "bearer"; token: string };

export type StalwartClientOptions = {
  baseUrl: string;
  auth: StalwartAuth;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type MethodCall = [name: string, args: Record<string, unknown>, callId: string];
type MethodResponse = [name: string, args: Record<string, unknown>, callId: string];

const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"] as const;

export class StalwartError extends Error {
  override readonly name = "StalwartError";
  constructor(
    message: string,
    readonly kind: "http" | "method" | "set" | "timeout",
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export class StalwartTransport {
  readonly #baseUrl: string;
  readonly #authHeader: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: StalwartClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#authHeader =
      opts.auth.type === "basic"
        ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString("base64")}`
        : `Bearer ${opts.auth.token}`;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetch ?? fetch;
  }

  /** GET /healthz/ready — 200 when the data store is up. Throws otherwise. */
  async ready(): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!res.ok) throw new StalwartError(`Stalwart not ready (HTTP ${res.status})`, "http");
  }

  /** Runs method calls in one request and returns responses keyed by call id. Method-level errors throw. */
  async call(calls: MethodCall[]): Promise<Map<string, Record<string, unknown>>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/jmap`, {
        method: "POST",
        headers: { Authorization: this.#authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ using: USING, methodCalls: calls }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new StalwartError("Stalwart request timed out", "timeout");
      }
      throw err;
    }
    if (!res.ok) throw new StalwartError(`Stalwart HTTP ${res.status}`, "http", { status: res.status });
    const body = (await res.json()) as { methodResponses?: MethodResponse[] };
    const out = new Map<string, Record<string, unknown>>();
    for (const [name, args, id] of body.methodResponses ?? []) {
      if (name === "error") throw new StalwartError(`Stalwart method error: ${String(args.type)}`, "method", args);
      out.set(id, args);
    }
    return out;
  }

  /** One `x:<Object>/set` call; throws on notCreated / notUpdated / notDestroyed. */
  async set(
    object: string,
    args: {
      create?: Record<string, Record<string, unknown>>;
      update?: Record<string, Record<string, unknown>>;
      destroy?: string[];
    },
  ): Promise<{ created: Record<string, { id: string } & Record<string, unknown>> }> {
    const res = (await this.call([[`${object}/set`, args, "s"]])).get("s") ?? {};
    for (const key of ["notCreated", "notUpdated", "notDestroyed"] as const) {
      const failed = res[key] as Record<string, unknown> | null | undefined;
      if (failed && Object.keys(failed).length > 0) {
        throw new StalwartError(`${object}/set ${key}`, "set", failed);
      }
    }
    return { created: (res.created ?? {}) as Record<string, { id: string } & Record<string, unknown>> };
  }

  /** `x:<Object>/get` for all ids (or a list), selected properties only. */
  async getAll<T extends { id: string }>(
    object: string,
    properties: string[],
    ids: string[] | null = null,
  ): Promise<T[]> {
    const res = (await this.call([[`${object}/get`, { ids, properties }, "g"]])).get("g") ?? {};
    return (res.list ?? []) as T[];
  }
}

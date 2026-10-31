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

/**
 * True when a `/set` refusal is Stalwart's `overQuota` (e.g. an account's `maxAppPasswords` reached), as opposed to
 * any other refusal of the same call.
 */
export function isOverQuotaError(err: unknown): boolean {
  if (!(err instanceof StalwartError) || err.kind !== "set") return false;
  const detail = err.detail;
  if (typeof detail !== "object" || detail === null) return false;
  return Object.values(detail).some(
    (v) => typeof v === "object" && v !== null && (v as { type?: unknown }).type === "overQuota",
  );
}

/** The pinned server's `maxObjectsInGet` (JMAP session `urn:ietf:params:jmap:core`). */
const MAX_OBJECTS_IN_GET = 500;

export class StalwartTransport {
  readonly #baseUrl: string;
  readonly #authHeader: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  /** `bearer` for an API key, `basic` for the dev recovery admin. */
  readonly authType: StalwartAuth["type"];

  constructor(opts: StalwartClientOptions) {
    this.authType = opts.auth.type;
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

  /**
   * The permissions this credential actually has (`GET /api/account`: for an API key, its own set capped by its
   * account's role). Used by the start-up scope check (`keys.ts` `credentialScopeProblems`).
   */
  async credentialPermissions(): Promise<string[]> {
    const res = await this.#fetch(`${this.#baseUrl}/api/account`, {
      headers: { Authorization: this.#authHeader },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new StalwartError(`Stalwart account HTTP ${res.status}`, "http", { status: res.status });
    const json = (await res.json()) as { permissions?: unknown };
    if (!Array.isArray(json.permissions)) throw new StalwartError("Stalwart account returned no permissions", "http");
    return json.permissions.filter((p): p is string => typeof p === "string");
  }

  /**
   * Runs method calls in one request and returns responses keyed by call id. Method-level errors throw. `headers` are
   * extra request headers (e.g. the mailbox-password marker the management proxy looks for).
   */
  async call(
    calls: MethodCall[],
    opts: { headers?: Record<string, string> } = {},
  ): Promise<Map<string, Record<string, unknown>>> {
    return this.rawCall(USING, calls, opts);
  }

  /**
   * Like `call`, but with the capabilities the calls need (standard JMAP objects such as `SieveScript` and `Blob`
   * aren't under `urn:stalwart:jmap`). Management credentials can act on another account by passing its id.
   */
  async rawCall(
    using: readonly string[],
    calls: MethodCall[],
    opts: { headers?: Record<string, string> } = {},
  ): Promise<Map<string, Record<string, unknown>>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/jmap`, {
        method: "POST",
        headers: { ...opts.headers, Authorization: this.#authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ using, methodCalls: calls }),
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

  /**
   * One `x:<Object>/set` call; throws on notCreated / notUpdated / notDestroyed. `accountId` targets another
   * account's objects (e.g. its app passwords); omitted, the server uses the caller's own.
   */
  async set(
    object: string,
    args: {
      accountId?: string;
      create?: Record<string, Record<string, unknown>>;
      update?: Record<string, Record<string, unknown>>;
      destroy?: string[];
    },
    opts: { headers?: Record<string, string> } = {},
  ): Promise<{ created: Record<string, { id: string } & Record<string, unknown>> }> {
    const res = (await this.call([[`${object}/set`, args, "s"]], opts)).get("s") ?? {};
    for (const key of ["notCreated", "notUpdated", "notDestroyed"] as const) {
      const failed = res[key] as Record<string, unknown> | null | undefined;
      if (failed && Object.keys(failed).length > 0) {
        throw new StalwartError(`${object}/set ${key}`, "set", failed);
      }
    }
    return { created: (res.created ?? {}) as Record<string, { id: string } & Record<string, unknown>> };
  }

  /** Uploads a blob to `accountId` and returns its blob id (`POST /jmap/upload/<account>/`). */
  async uploadBlob(accountId: string, contentType: string, body: Uint8Array<ArrayBuffer> | string): Promise<string> {
    const res = await this.#fetch(`${this.#baseUrl}/jmap/upload/${encodeURIComponent(accountId)}/`, {
      method: "POST",
      headers: { Authorization: this.#authHeader, "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new StalwartError(`Stalwart upload HTTP ${res.status}`, "http", { status: res.status });
    const json = (await res.json()) as { blobId?: unknown };
    if (typeof json.blobId !== "string") throw new StalwartError("Stalwart upload returned no blob id", "http");
    return json.blobId;
  }

  /** Downloads a blob of `accountId` as text (`GET /jmap/download/<account>/<blob>/`). */
  async downloadBlob(accountId: string, blobId: string): Promise<string> {
    const url = `${this.#baseUrl}/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/blob`;
    const res = await this.#fetch(url, {
      headers: { Authorization: this.#authHeader },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new StalwartError(`Stalwart download HTTP ${res.status}`, "http", { status: res.status });
    return res.text();
  }

  /** `x:<Object>/get` for all ids (or a list), selected properties only; `accountId` as for `set`. */
  async getAll<T extends { id: string }>(
    object: string,
    properties: string[],
    ids: string[] | null = null,
    accountId?: string,
  ): Promise<T[]> {
    const scope = accountId === undefined ? {} : { accountId };
    const get = async (want: string[] | null): Promise<T[]> => {
      const res = (await this.call([[`${object}/get`, { ids: want, properties, ...scope }, "g"]])).get("g") ?? {};
      return (res.list ?? []) as T[];
    };
    if (ids !== null) {
      const out: T[] = [];
      for (let i = 0; i < ids.length; i += MAX_OBJECTS_IN_GET)
        out.push(...(await get(ids.slice(i, i + MAX_OBJECTS_IN_GET))));
      return out;
    }
    // `ids: null` answers at most the server's `maxObjectsInGet` (500 on v0.16.27) and silently drops the rest
    // (verified: 500 of 627 accounts). A full page means there may be more: list every id with `/query`, then get them
    // in pages.
    const first = await get(null);
    if (first.length < MAX_OBJECTS_IN_GET) return first;
    const all: string[] = [];
    for (let position = 0; ; position += MAX_OBJECTS_IN_GET) {
      const q = (await this.call([[`${object}/query`, { position, limit: MAX_OBJECTS_IN_GET, ...scope }, "q"]])).get(
        "q",
      );
      const page = (q?.ids ?? []) as string[];
      all.push(...page);
      if (page.length < MAX_OBJECTS_IN_GET) break;
    }
    return this.getAll<T>(object, properties, all, accountId);
  }
}

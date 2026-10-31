// SPDX-License-Identifier: MIT
/**
 * Minimal typed JMAP client (RFC 8620 / 8621). Never logs or persists message content.
 */

export const CAPABILITIES = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
} as const;

export type JmapSession = {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  username: string;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
};

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export type Mailbox = { id: string; name: string; role: string | null; totalEmails: number; unreadEmails: number };

export type EmailAddress = { name: string | null; email: string };

export type EmailSummary = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
};

export class JmapError extends Error {
  override readonly name = "JmapError";
  constructor(
    message: string,
    readonly type: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export type JmapClientOptions = {
  /** Session URL, e.g. `${origin}/jmap/session`. */
  sessionUrl: string;
  /** Full Authorization header value. Server-side only; the browser goes through the proxy instead. */
  authorization?: string;
  /**
   * Rewrites URLs advertised in the session (apiUrl, uploadUrl, …) so calls go to the same origin we used,
   * e.g. through the proxy. Defaults to "replace the advertised origin with the session URL's origin".
   */
  rewriteUrl?: (advertised: string) => string;
  fetch?: typeof fetch;
};

export class JmapClient {
  #session: JmapSession | null = null;
  #loading: Promise<JmapSession> | null = null;
  readonly #opts: JmapClientOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: JmapClientOptions) {
    this.#opts = opts;
    // Wrapped, not stored: browsers throw "Illegal invocation" when fetch is called with another `this`.
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  #headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.#opts.authorization ? { Authorization: this.#opts.authorization } : {}),
    };
  }

  #rewrite(url: string): string {
    if (this.#opts.rewriteUrl) return this.#opts.rewriteUrl(url);
    const origin = new URL(this.#opts.sessionUrl).origin;
    return url.replace(/^https?:\/\/[^/]+/, origin);
  }

  /**
   * The JMAP Session resource, fetched once and kept. Callers asking while it is on its way share that one fetch
   * (a failed fetch is forgotten, so the next call tries again); `refresh` fetches it again.
   */
  async session(refresh = false): Promise<JmapSession> {
    if (this.#session && !refresh) return this.#session;
    if (this.#loading && !refresh) return this.#loading;
    const loading = (async () => {
      const res = await this.#fetch(this.#opts.sessionUrl, { headers: this.#headers() });
      if (!res.ok) throw new JmapError(`JMAP session HTTP ${res.status}`, "http", { status: res.status });
      return this.#use((await res.json()) as JmapSession);
    })();
    this.#loading = loading;
    try {
      return await loading;
    } finally {
      if (this.#loading === loading) this.#loading = null;
    }
  }

  /**
   * Uses a Session resource the caller already has (e.g. one sent with the page's first data), so the first request
   * doesn't wait for a session fetch. Its URLs are rewritten like a fetched one's.
   */
  prime(session: JmapSession): void {
    this.#use(session);
  }

  #use(s: JmapSession): JmapSession {
    this.#session = { ...s, apiUrl: this.#rewrite(s.apiUrl), uploadUrl: this.#rewrite(s.uploadUrl) };
    return this.#session;
  }

  async accountId(): Promise<string> {
    const s = await this.session();
    const id = s.primaryAccounts[CAPABILITIES.mail];
    if (!id) throw new JmapError("No mail account in JMAP session", "noAccount");
    return id;
  }

  /**
   * Sends method calls; returns responses keyed by call id. Method-level `error` responses throw.
   * The first response for an id wins: implicit calls (e.g. the Email/set triggered by
   * `onSuccessUpdateEmail`) reuse the caller's id (RFC 8620 §5.4) and must not shadow it.
   */
  async request(
    calls: Invocation[],
    using: string[] = Object.values(CAPABILITIES),
  ): Promise<Map<string, Record<string, unknown>>> {
    const s = await this.session();
    const res = await this.#fetch(s.apiUrl, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ using, methodCalls: calls }),
    });
    if (!res.ok) throw new JmapError(`JMAP HTTP ${res.status}`, "http", { status: res.status });
    const body = (await res.json()) as { methodResponses: Invocation[] };
    const out = new Map<string, Record<string, unknown>>();
    for (const [name, args, id] of body.methodResponses) {
      if (name === "error") throw new JmapError(`JMAP method error: ${String(args.type)}`, String(args.type), args);
      if (!out.has(id)) out.set(id, args);
    }
    return out;
  }

  /**
   * Uploads a blob (RFC 8620 §6.1) and returns its id, e.g. for `Email/import` or an attachment. The upload URL
   * comes from the session (rewritten like the API URL).
   */
  async upload(data: Uint8Array | string, type: string): Promise<string> {
    const s = await this.session();
    const accountId = await this.accountId();
    const url = s.uploadUrl.replace("{accountId}", encodeURIComponent(accountId));
    const res = await this.#fetch(url, {
      method: "POST",
      headers: { ...this.#headers(), "Content-Type": type },
      body: typeof data === "string" ? data : new Blob([new Uint8Array(data)], { type }),
    });
    if (!res.ok) throw new JmapError(`JMAP upload HTTP ${res.status}`, "http", { status: res.status });
    const body = (await res.json()) as { blobId?: unknown };
    if (typeof body.blobId !== "string") throw new JmapError("Upload returned no blobId", "upload");
    return body.blobId;
  }

  async mailboxes(): Promise<Mailbox[]> {
    const accountId = await this.accountId();
    const res = await this.request([
      ["Mailbox/get", { accountId, ids: null, properties: ["name", "role", "totalEmails", "unreadEmails"] }, "m"],
    ]);
    return (res.get("m")?.list ?? []) as Mailbox[];
  }

  async mailboxByRole(role: string): Promise<Mailbox | undefined> {
    return (await this.mailboxes()).find((m) => m.role === role);
  }

  /** Newest-first summaries in a mailbox (list-view properties only, never bodies). */
  async listEmails(mailboxId: string, limit = 50): Promise<EmailSummary[]> {
    const accountId = await this.accountId();
    const res = await this.request([
      [
        "Email/query",
        { accountId, filter: { inMailbox: mailboxId }, sort: [{ property: "receivedAt", isAscending: false }], limit },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview"],
        },
        "g",
      ],
    ]);
    return (res.get("g")?.list ?? []) as EmailSummary[];
  }

  /**
   * Creates a plain-text message in Drafts and submits it; on success it moves to Sent and drops `$draft`.
   * Returns the EmailSubmission id.
   */
  async sendText(input: { from: string; to: string[]; subject: string; text: string }): Promise<string> {
    const accountId = await this.accountId();
    const [drafts, sent, identities] = await Promise.all([
      this.mailboxByRole("drafts"),
      this.mailboxByRole("sent"),
      this.request([["Identity/get", { accountId, ids: null }, "i"]]),
    ]);
    if (!drafts || !sent) throw new JmapError("Drafts or Sent mailbox missing", "noMailbox");
    const identity = ((identities.get("i")?.list ?? []) as { id: string; email: string }[]).find(
      (i) => i.email === input.from,
    );
    if (!identity) throw new JmapError(`No identity for ${input.from}`, "noIdentity");
    const res = await this.request([
      [
        "Email/set",
        {
          accountId,
          create: {
            draft: {
              mailboxIds: { [drafts.id]: true },
              keywords: { $draft: true, $seen: true },
              from: [{ email: input.from }],
              to: input.to.map((email) => ({ email })),
              subject: input.subject,
              bodyValues: { body: { value: input.text } },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "e",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: { sub: { identityId: identity.id, emailId: "#draft" } },
          onSuccessUpdateEmail: {
            "#sub": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null },
          },
        },
        "s",
      ],
    ]);
    const notCreated = res.get("s")?.notCreated as Record<string, unknown> | undefined;
    if (notCreated && Object.keys(notCreated).length > 0) {
      throw new JmapError("Submission rejected", "notCreated", notCreated);
    }
    const created = res.get("s")?.created as Record<string, { id: string }> | undefined;
    const id = created?.sub?.id;
    if (!id) throw new JmapError("Submission not created", "notCreated", res.get("e"));
    return id;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Browser side of passkeys: turns the server's WebAuthn options (JSON, base64url) into what
 * `navigator.credentials` wants, and the resulting credential back into JSON for the server. The ceremony itself is
 * checked by the server (better-auth passkey plugin): challenge, origin, relying party and user verification.
 */

const toBytes = (b64url: string): ArrayBuffer => {
  const b64 = b64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const toB64url = (buf: ArrayBuffer | ArrayBufferView | null | undefined): string | undefined => {
  if (!buf) return undefined;
  const bytes =
    buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type CredentialDescriptorJSON = { id: string; type?: string; transports?: string[] };

type CreationOptionsJSON = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: CredentialDescriptorJSON[];
};

type RequestOptionsJSON = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: CredentialDescriptorJSON[];
};

const descriptor = (d: CredentialDescriptorJSON): PublicKeyCredentialDescriptor => ({
  id: toBytes(d.id),
  type: "public-key",
  ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
});

/** True when this browser can use passkeys at all (a secure context with WebAuthn). */
export const passkeysSupported = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext && typeof window.PublicKeyCredential === "function";

/** Creates a passkey from registration options; returns the attestation as JSON for the server. */
export async function createPasskey(options: CreationOptionsJSON): Promise<Record<string, unknown>> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: toBytes(options.challenge),
    user: { ...options.user, id: toBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(descriptor),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const res = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      attestationObject: toB64url(res.attestationObject),
      transports: typeof res.getTransports === "function" ? res.getTransports() : [],
      ...(typeof res.getAuthenticatorData === "function"
        ? { authenticatorData: toB64url(res.getAuthenticatorData()) }
        : {}),
      ...(typeof res.getPublicKey === "function" ? { publicKey: toB64url(res.getPublicKey()) } : {}),
      ...(typeof res.getPublicKeyAlgorithm === "function" ? { publicKeyAlgorithm: res.getPublicKeyAlgorithm() } : {}),
    },
  };
}

/** Signs in with a passkey from authentication options; returns the assertion as JSON for the server. */
export async function assertPasskey(options: RequestOptionsJSON): Promise<Record<string, unknown>> {
  const { allowCredentials, ...rest } = options;
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...rest,
    challenge: toBytes(options.challenge),
    ...(allowCredentials ? { allowCredentials: allowCredentials.map(descriptor) } : {}),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was used.");
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      authenticatorData: toB64url(res.authenticatorData),
      signature: toB64url(res.signature),
      userHandle: toB64url(res.userHandle),
    },
  };
}

/** A person cancelled or the browser refused: a calm message, never the raw error. */
export function passkeyError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return "The passkey request was cancelled or timed out.";
  if (name === "InvalidStateError") return "This passkey is already registered to your login.";
  if (name === "SecurityError") return "Passkeys only work on the console's own address.";
  return "Your browser couldn't use a passkey. Try again or use another method.";
}

/**
 * Server JSON helper for the auth endpoints (better-auth answers `{ code, message }` on errors). `data` is the raw
 * JSON: callers read only the fields they expect.
 */
export async function authCall(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; code: string; message: string }> {
  try {
    const res = await fetch(`/api/auth${path}`, {
      method: init.method,
      headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const json = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string };
    } | null;
    if (res.ok) return { ok: true, data: json };
    const code = json?.code ?? json?.error?.code ?? "";
    const message =
      res.status === 429
        ? "Too many attempts. Wait a few minutes and try again."
        : (json?.message ?? json?.error?.message ?? "Something went wrong. Try again.");
    return { ok: false, status: res.status, code, message };
  } catch {
    return { ok: false, status: 0, code: "network", message: "Couldn't reach the server. Check your connection." };
  }
}

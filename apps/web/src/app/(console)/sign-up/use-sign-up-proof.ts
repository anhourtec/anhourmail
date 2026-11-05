// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SIGN_UP_CODE_HEADER } from "@anhourmail/shared/proof-of-work";

import { type PowRequest, type PowResponse, powProgress } from "./pow-messages";

/** A solved challenge, spent by one sign-up request. */
export type SignUpProof = { challenge: string; proof: string };

export type ProofState =
  | { status: "solving"; progress: number }
  | { status: "ready" }
  | { status: "failed"; reason: "unsupported" | "network" | "limited" | "error" };

type Solved = SignUpProof & { expiresAt: number };

/** A challenge this close to expiry is solved again before it is sent. */
const EXPIRY_MARGIN_MS = 30_000;

type Challenge = { challenge: string; bits: number; expiresAt: string };

async function fetchChallenge(code: string | null): Promise<Challenge | "limited" | "network"> {
  try {
    const res = await fetch("/api/sign-up/challenge", {
      method: "POST",
      // With sign-up closed, a challenge is issued only to a page that carries an invite code (ADR-0029 §8).
      headers: { "Content-Type": "application/json", ...(code ? { [SIGN_UP_CODE_HEADER]: code } : {}) },
      body: "{}",
    });
    if (res.status === 429) return "limited";
    if (!res.ok) return "network";
    const json = (await res.json()) as { data?: Challenge };
    return json.data ?? "network";
  } catch {
    return "network";
  }
}

/**
 * The sign-up proof-of-work (ADR-0031): fetches a challenge as soon as the page is interactive and solves it in a Web
 * Worker, with no action from the person. `take()` hands out the solution for one request (waiting for it if the
 * solve is still running, solving again if it expired); `restart()` starts the next one (after a refused attempt, or
 * "Try again" after a failure).
 */
export function useSignUpProof(enabled: boolean, inviteCode: string | null = null) {
  const [state, setState] = useState<ProofState>({ status: "solving", progress: 0 });
  const current = useRef<Promise<Solved | null> | null>(null);
  const stop = useRef<(() => void) | null>(null);
  // Read when a challenge is fetched (a code typed later goes with the next one; the proof isn't tied to it).
  const code = useRef(inviteCode);
  useEffect(() => {
    code.current = inviteCode;
  }, [inviteCode]);

  const start = useCallback((): Promise<Solved | null> => {
    stop.current?.();
    const run = (async (): Promise<Solved | null> => {
      const c = await fetchChallenge(code.current);
      if (c === "limited" || c === "network") {
        setState({ status: "failed", reason: c });
        return null;
      }
      setState({ status: "solving", progress: 0 });
      return new Promise<Solved | null>((resolve) => {
        let worker: Worker;
        try {
          worker = new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
        } catch {
          setState({ status: "failed", reason: "unsupported" });
          resolve(null);
          return;
        }
        const finish = (out: Solved | null) => {
          worker.terminate();
          stop.current = null;
          resolve(out);
        };
        stop.current = () => {
          finish(null);
        };
        worker.onmessage = (e: MessageEvent<PowResponse>) => {
          const m = e.data;
          if (m.type === "progress") setState({ status: "solving", progress: powProgress(m.tried, c.bits) });
          else if (m.type === "solved") {
            setState({ status: "ready" });
            finish({ challenge: c.challenge, proof: m.proof, expiresAt: Date.parse(c.expiresAt) });
          } else {
            setState({ status: "failed", reason: m.reason });
            finish(null);
          }
        };
        worker.onerror = () => {
          setState({ status: "failed", reason: "unsupported" });
          finish(null);
        };
        const request: PowRequest = { challenge: c.challenge, bits: c.bits };
        worker.postMessage(request);
      });
    })();
    current.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void start();
    return () => {
      stop.current?.();
    };
  }, [enabled, start]);

  const take = useCallback(async (): Promise<SignUpProof | null> => {
    let solved = await (current.current ?? start());
    if (solved && solved.expiresAt - Date.now() < EXPIRY_MARGIN_MS) solved = await start();
    // Single use: the next request needs a new one.
    current.current = null;
    return solved ? { challenge: solved.challenge, proof: solved.proof } : null;
  }, [start]);

  const restart = useCallback(() => {
    void start();
  }, [start]);

  return { state, take, restart };
}

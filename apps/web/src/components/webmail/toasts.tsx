// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Toast = {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
  tone?: "default" | "error";
  /** Milliseconds before it goes away. */
  duration?: number;
};

type ShowToast = (t: Omit<Toast, "id">) => number;

const ToastContext = createContext<{ show: ShowToast; dismiss: (id: number) => void }>({
  show: () => 0,
  dismiss: () => undefined,
});

export const useToasts = () => useContext(ToastContext);

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  // The timer starts once per toast; re-renders of the host must not restart it.
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const t = window.setTimeout(() => {
      done.current();
    }, toast.duration ?? 5000);
    return () => {
      window.clearTimeout(t);
    };
  }, [toast.duration]);
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg ${
        toast.tone === "error" ? "border-destructive/40 bg-card text-destructive" : "bg-foreground text-background"
      }`}
    >
      <p className="text-[13.5px]">{toast.message}</p>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onDone();
          }}
          className="shrink-0 rounded-md px-2 py-0.5 font-medium text-[13.5px] underline underline-offset-2 hover:opacity-80"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDone}
        aria-label="Dismiss"
        className="-mr-1 inline-flex size-6 items-center justify-center rounded-md opacity-70 hover:opacity-100"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Bottom-centre notices ("Archived. Undo"); above the mobile action bar. */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const show = useCallback<ShowToast>((t) => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    return id;
  }, []);
  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDone={() => {
              dismiss(t.id);
            }}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

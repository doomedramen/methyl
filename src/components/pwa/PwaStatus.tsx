"use client";

import { useCallback } from "react";
import { formatBytes, usePwa } from "@/lib/browser/pwa";

/** Compact status bar: install affordance, storage persistence, quota. */
export function PwaStatus() {
  const pwa = usePwa();

  const install = useCallback(async () => {
    if (!pwa.installPrompt) return;
    await pwa.installPrompt.prompt();
  }, [pwa.installPrompt]);

  const used = pwa.quota?.usage;
  const total = pwa.quota?.quota;

  return (
    <div className="flex items-center gap-3 px-3 text-[10px] text-zinc-400">
      <span
        title={
          pwa.swRegistered
            ? "offline app shell ready"
            : "service worker not active"
        }
        className="flex items-center gap-1"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            pwa.swRegistered ? "bg-emerald-400" : "bg-zinc-300"
          }`}
        />
        {pwa.swRegistered ? "offline ready" : "offline: booting"}
      </span>
      {pwa.installPrompt && (
        <button
          onClick={install}
          className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
        >
          Install
        </button>
      )}
      <span title="navigator.storage.persisted">
        <span
          className={
            pwa.persistent === true
              ? "text-emerald-600"
              : pwa.persistent === false
                ? "text-amber-500"
                : "opacity-60"
          }
        >
          {pwa.persistent === undefined || pwa.persistent === null
            ? "storage: ?"
            : pwa.persistent
              ? "storage: persistent"
              : "storage: best-effort"}
        </span>
      </span>
      {total !== undefined && used !== undefined && (
        <span
          title={`${formatBytes(used)} of ${formatBytes(total)}`}
          className="tabular-nums"
        >
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      )}
    </div>
  );
}
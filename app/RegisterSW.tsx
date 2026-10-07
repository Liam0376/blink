"use client";

import { useEffect, useState } from "react";

export default function RegisterSW() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (cancelled) return;
        // A new shell already installed while this tab was open elsewhere.
        if (reg.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            // Installed, but the old worker still controls this page.
            // sw.js uses skipWaiting + clients.claim, so the new shell
            // takes over on its own — prompt instead of force-reloading.
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          });
        });
      })
      .catch(() => {
        /* offline shell is best-effort */
      });
    // skipWaiting + clients.claim means a fresh worker can take control of
    // this already-open tab at any moment. Never auto-reload here: QuickAdd
    // holds unsaved amount/note/photo state, so the user reloads on their
    // own terms instead of losing a mid-entry form.
    const onControllerChange = () => setUpdateReady(true);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!updateReady) return null;
  return (
    <div
      role="status"
      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2.5rem)] max-w-sm px-4 py-3 rounded-2xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold text-center shadow-xl"
    >
      New version available.{" "}
      <button onClick={() => window.location.reload()} className="underline underline-offset-2">
        Reload
      </button>
      {" · "}
      <button onClick={() => setUpdateReady(false)} className="underline underline-offset-2 opacity-60">
        Later
      </button>
    </div>
  );
}

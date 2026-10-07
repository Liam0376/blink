"use client";

export function ErrorCard({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="w-full max-w-md rounded-3xl p-6 shadow-lg" style={{ background: "var(--card)" }}>
      <div className="text-center space-y-4">
        <div className="text-5xl">⚡</div>
        <h1 className="text-xl font-extrabold">Something went wrong</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          We encountered an unexpected error. The good news: your data is safe.
          All your transactions and accounts are stored on this phone, unaffected
          by this error.
        </p>
        <div className="flex gap-2 pt-4">
          <button
            onClick={() => { reset(); window.location.reload(); }}
            className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-br from-violet-500 to-violet-600 text-white font-bold text-sm min-h-[44px] transition-transform active:scale-95"
          >
            Reload
          </button>
        </div>
        {error.digest && (
          <p className="text-[11px] pt-2" style={{ color: "var(--muted)" }}>Error ID: {error.digest}</p>
        )}
      </div>
    </div>
  );
}

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  console.error("Page error:", error);
  return (
    <div className="min-h-dvh flex items-center justify-center px-4" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <ErrorCard error={error} reset={reset} />
    </div>
  );
}

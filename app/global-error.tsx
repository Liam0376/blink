"use client";

import "./globals.css";
import { ErrorCard } from "./error";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  console.error("Global error:", error);
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <title>Blink — Error</title>
        <meta name="theme-color" content="#7c3aed" />
      </head>
      <body className="min-h-full flex items-center justify-center px-4" style={{ background: "var(--background)", color: "var(--foreground)" }}>
        <ErrorCard error={error} reset={reset} />
      </body>
    </html>
  );
}

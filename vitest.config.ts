import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    // Pin the test process to UTC so date-math tests (which write explicit
    // "...Z" ISO strings) are deterministic regardless of the machine/CI
    // runner's local timezone. Production code that reads the user's local
    // time (e.g. growBalance's day-stepping) is unaffected — TZ only
    // controls this Node process, never a real user's browser.
    env: { TZ: "UTC" },
  },
});

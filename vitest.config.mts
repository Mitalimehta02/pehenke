import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // lib code imports "server-only"; tests run outside Next, like the spike scripts
      "server-only": path.join(root, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    // PGlite (in-process Postgres) start-up is slow on a busy machine
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});

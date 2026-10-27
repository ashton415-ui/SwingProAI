import { defineConfig } from "vitest/config";
import path from "node:path";

// ENT-1D application-to-database integration (DISPOSABLE LOCAL STACK ONLY).
// Separate from the repository's unit-test config: it includes only this
// directory, runs files one at a time against the shared local database, and
// loads no .env file (envDir is this directory, which holds none).
export default defineConfig({
  root: path.resolve(__dirname, "../../.."),
  envDir: __dirname,
  test: {
    environment: "node",
    include: ["supabase/tests/app-integration/**/*.integration.test.ts"],
    setupFiles: [path.resolve(__dirname, "ent1d-app-setup.ts")],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "../../..") },
  },
});

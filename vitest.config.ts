import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx"],
  },
  resolve: {
    // Mirror the tsconfig "@/..." path alias so test imports match app code.
    alias: { "@": path.resolve(__dirname, ".") },
  },
});

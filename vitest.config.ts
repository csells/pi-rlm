import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    testTimeout: 10_000,
    hookTimeout: 30_000,
    typecheck: { enabled: true },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/ui/**", "src/index.ts"],
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 85,
      },
    },
  },
});

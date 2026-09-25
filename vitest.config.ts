import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { NODE_ENV: "test" },
    // Each file starts its own in-memory MongoDB; the first run downloads the binary.
    hookTimeout: 300_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
});

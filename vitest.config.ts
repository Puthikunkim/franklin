import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Playwright e2e specs use their own runner; keep them out of vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
  },
});

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Integration tests share ONE local Supabase DB and mutate global fixtures
    // (test_reset/cleanupDrafts), so run test files sequentially — parallel files
    // otherwise stomp each other's state and fail nondeterministically.
    fileParallelism: false,
    // Playwright e2e specs use their own runner; keep them out of vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
    },
  },
});

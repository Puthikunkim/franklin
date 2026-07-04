import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // Reset the DB to a clean seed before the e2e run so the suite is self-contained
  // and unaffected by a prior (destructive) place_bid integration run.
  globalSetup: "./tests/e2e/global-setup.ts",
  // All spec files share one Next.js dev server + one local Supabase DB. Running
  // spec files in parallel workers puts enough concurrent CPU/network load on the
  // dev server that client-side navigations (login redirect, Link prefetch) can
  // occasionally race an in-flight Next.js dev-mode prefetch/HMR event and get
  // silently dropped (observed as a stuck URL after a click). Serial execution
  // removes that contention and has proven stable; parallel workers has not.
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

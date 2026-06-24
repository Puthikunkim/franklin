import { execSync } from "node:child_process";

// The bidding smoke test bids on the seeded anchor auction, which must be live
// with its starting state. The place_bid integration suite (vitest) mutates that
// same auction via the test helpers, so without a reset a prior `vitest` run would
// leave the anchor expired and fail the e2e. Reset to a clean seed before e2e runs.
export default async function globalSetup() {
  execSync("npx supabase db reset", { stdio: "inherit" });
  // `db reset` restarts the realtime container; give it a moment to start streaming
  // before tests subscribe, otherwise the first realtime event can be dropped.
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

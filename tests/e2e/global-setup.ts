import { execSync } from "node:child_process";

// The bidding smoke test bids on the seeded anchor auction, which must be live
// with its starting state. The place_bid integration suite (vitest) mutates that
// same auction via the test helpers, so without a reset a prior `vitest` run would
// leave the anchor expired and fail the e2e. Reset to a clean seed before e2e runs.
export default function globalSetup() {
  execSync("npx supabase db reset", { stdio: "inherit" });
}

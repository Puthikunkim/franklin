import { createClient } from "@supabase/supabase-js";

// Local supabase defaults from `supabase start` output:
export const admin = createClient(
  process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
);

export async function resetDb() {
  // Truncate bids/settlements and reset auction cached state between tests.
  const { error } = await admin.rpc("test_reset"); // defined in migration
  if (error) throw error;
}

// Remove draft auctions (and their now-orphaned vehicles) created by listing tests.
export async function cleanupDrafts() {
  const { data: drafts } = await admin.from("auctions").select("id, vehicle_id").eq("status", "draft");
  const ids = (drafts ?? []).map((d) => d.id);
  const vids = (drafts ?? []).map((d) => d.vehicle_id);
  if (ids.length) await admin.from("auctions").delete().in("id", ids);
  if (vids.length) await admin.from("vehicles").delete().in("id", vids);
}

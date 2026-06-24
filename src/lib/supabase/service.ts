import { createClient } from "@supabase/supabase-js";

// Server-only: uses the service-role key. NEVER import this into a "use client" module.
export function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

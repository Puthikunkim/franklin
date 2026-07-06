import { serverClient } from "@/lib/supabase/server";
import { setDealerId } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const sb = await serverClient();
  const { data: dealers } = await sb.from("dealers").select("*").order("business_name");

  async function pick(formData: FormData) {
    "use server";
    await setDealerId(String(formData.get("id")));
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-8">
        <div className="mb-4 flex items-center gap-2.5">
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded bg-signal font-mono text-sm font-bold text-ink">
            WD
          </span>
          <span className="font-display text-sm font-semibold tracking-tight text-chalk">
            Wholesale Dealer Auctions
          </span>
        </div>
        <p className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-fog">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-live rounded-full bg-signal" />
          Trade access
        </p>
        <h1 className="font-display text-2xl font-bold text-chalk">Choose your dealer</h1>
      </div>
      <form action={pick} className="space-y-2">
        {dealers?.map((d) => (
          <button
            key={d.id}
            name="id"
            value={d.id}
            className="flex w-full items-center gap-3 rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:border-signal/40"
          >
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-ink font-mono text-xs font-bold uppercase text-signal">
              {d.initials}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm text-chalk">{d.business_name}</span>
              <span className="block font-mono text-xs text-fog">{d.region}</span>
            </span>
          </button>
        ))}
      </form>
    </main>
  );
}

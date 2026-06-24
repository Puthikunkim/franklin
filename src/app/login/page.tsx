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
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-semibold mb-4">Choose your dealer</h1>
      <form action={pick} className="space-y-2">
        {dealers?.map((d) => (
          <button
            key={d.id}
            name="id"
            value={d.id}
            className="w-full rounded border border-neutral-700 p-3 text-left hover:bg-neutral-800"
          >
            {d.business_name} · {d.region}
          </button>
        ))}
      </form>
    </main>
  );
}

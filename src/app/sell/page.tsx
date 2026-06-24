import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { ListingForm } from "@/components/ListingForm";
import { createDraftAction } from "./actions";

export default async function SellPage() {
  if (!(await getDealerId())) redirect("/login");
  return (
    <main className="px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">List a vehicle</h1>
      <ListingForm action={createDraftAction} submitLabel="Save draft" />
    </main>
  );
}

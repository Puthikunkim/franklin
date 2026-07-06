import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { Header } from "@/components/Header";
import { ListingForm } from "@/components/ListingForm";
import { createDraftAction } from "./actions";

export default async function SellPage() {
  if (!(await getDealerId())) redirect("/login");
  return (
    <>
      <Header />
      <main className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="mb-6 font-display text-2xl font-bold text-chalk">List a vehicle</h1>
        <ListingForm action={createDraftAction} submitLabel="Save draft" />
      </main>
    </>
  );
}

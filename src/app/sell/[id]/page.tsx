import { notFound, redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { getAuctionById } from "@/lib/auctions";
import { ListingForm } from "@/components/ListingForm";
import { updateDraftAction } from "../actions";

export default async function EditDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const a = await getAuctionById(id);
  if (!a || a.status !== "draft" || a.seller_dealer_id !== dealerId) notFound();
  const v = a.vehicle;
  return (
    <main className="px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">Edit draft</h1>
      <ListingForm action={updateDraftAction} submitLabel="Update draft" initial={{
        auctionId: a.id, make: v.make, model: v.model, year: v.year, variant: v.variant ?? "",
        odometerKm: v.odometer_km, grade: v.grade, color: v.color ?? "",
        mechanicalNotes: v.mechanical_notes ?? "", appraisalNotes: v.appraisal_notes ?? "",
        photoUrls: v.photo_urls ?? [],
        startingPrice: String(a.starting_price / 100), reservePrice: String(a.reserve_price / 100),
        buyNowPrice: a.buy_now_price ? String(a.buy_now_price / 100) : "",
        endTime: new Date(a.end_time).toISOString().slice(0, 16),
      }} />
    </main>
  );
}

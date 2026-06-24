"use server";

import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { createDraft, updateDraft } from "@/lib/listings/service";
import { ListingInput, ValidationErrors } from "@/lib/listings/validation";
import { dollarsToCents } from "@/lib/money";

export type FormState = { errors?: ValidationErrors & { _form?: string } };

function parse(formData: FormData): ListingInput {
  const dollars = (k: string) => dollarsToCents(Number(formData.get(k) || 0));
  const buyNowRaw = String(formData.get("buyNowPrice") || "").trim();
  return {
    make: String(formData.get("make") || ""),
    model: String(formData.get("model") || ""),
    year: Number(formData.get("year") || 0),
    variant: String(formData.get("variant") || ""),
    odometerKm: Number(formData.get("odometerKm") || 0),
    grade: String(formData.get("grade") || "A") as ListingInput["grade"],
    color: String(formData.get("color") || ""),
    mechanicalNotes: String(formData.get("mechanicalNotes") || ""),
    appraisalNotes: String(formData.get("appraisalNotes") || ""),
    photoUrls: formData.getAll("photoUrls").map(String).filter(Boolean),
    startingPrice: dollars("startingPrice"),
    reservePrice: dollars("reservePrice"),
    buyNowPrice: buyNowRaw ? dollarsToCents(Number(buyNowRaw)) : null,
    endTime: new Date(String(formData.get("endTime") || "")).toISOString(),
  };
}

export async function createDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const r = await createDraft(dealerId, parse(formData));
  if (!r.ok) return { errors: r.errors };
  redirect(`/auction/${r.auctionId}`);
}

export async function updateDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await updateDraft(dealerId, auctionId, parse(formData));
  if (!r.ok) return { errors: r.errors };
  redirect(`/auction/${auctionId}`);
}

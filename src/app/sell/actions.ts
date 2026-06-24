"use server";

import { redirect } from "next/navigation";
import { getDealerId } from "@/lib/session";
import { createDraft, updateDraft, publishListing } from "@/lib/listings/service";
import { ListingInput, ValidationErrors } from "@/lib/listings/validation";
import { dollarsToCents } from "@/lib/money";

export type FormState = { errors?: ValidationErrors & { _form?: string } };

function parse(formData: FormData): ListingInput {
  const dollars = (k: string) => dollarsToCents(Number(formData.get(k) || 0));
  const buyNowRaw = String(formData.get("buyNowPrice") || "").trim();
  const endRaw = String(formData.get("endTime") || "").trim();
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
    // Keep a blank/garbage date as-is so validateListing returns a friendly field error
    // instead of new Date("").toISOString() throwing a RangeError (500).
    endTime: endRaw && !Number.isNaN(Date.parse(endRaw)) ? new Date(endRaw).toISOString() : endRaw,
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

const PUBLISH_MESSAGES: Record<string, string> = {
  not_owner: "You can only publish your own draft.",
  not_draft: "This listing is already published.",
  end_in_past: "Your auction end time is in the past — edit the draft and pick a new time.",
  no_photos: "Add at least one photo before publishing.",
  error: "Could not publish, try again.",
};

export async function publishAction(_prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const dealerId = await getDealerId();
  if (!dealerId) redirect("/login");
  const auctionId = String(formData.get("auctionId") || "");
  const r = await publishListing(dealerId, auctionId);
  if (r.ok) redirect(`/auction/${auctionId}`);
  return { error: PUBLISH_MESSAGES[r.reason ?? "error"] ?? "Could not publish." };
}

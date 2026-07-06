"use client";

import { useActionState } from "react";
import { PhotoUploader } from "./PhotoUploader";
import { EndTimeField } from "./EndTimeField";
import type { FormState } from "@/app/sell/actions";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Initial = {
  auctionId?: string; make?: string; model?: string; year?: number; variant?: string;
  odometerKm?: number; grade?: string; color?: string; mechanicalNotes?: string;
  appraisalNotes?: string; photoUrls?: string[]; startingPrice?: string; reservePrice?: string;
  buyNowPrice?: string; endTime?: string;
};

export function ListingForm({ action, initial = {}, submitLabel }:
  { action: Action; initial?: Initial; submitLabel: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  const err = state.errors ?? {};
  const field = "w-full rounded-md border border-line bg-panel px-3 py-2 text-chalk focus:border-signal focus:outline-none";

  return (
    <form action={formAction} className="space-y-4 max-w-xl">
      {initial.auctionId && <input type="hidden" name="auctionId" value={initial.auctionId} />}
      {err._form && <p className="text-stop text-sm">{err._form}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1"><span className="text-xs text-fog">Make</span>
          <input name="make" defaultValue={initial.make} className={field} />
          {err.make && <span className="text-xs text-stop">{err.make}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-fog">Model</span>
          <input name="model" defaultValue={initial.model} className={field} />
          {err.model && <span className="text-xs text-stop">{err.model}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-fog">Year</span>
          <input name="year" type="number" defaultValue={initial.year} className={field} />
          {err.year && <span className="text-xs text-stop">{err.year}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-fog">Variant</span>
          <input name="variant" defaultValue={initial.variant} className={field} /></label>
        <label className="space-y-1"><span className="text-xs text-fog">Odometer (km)</span>
          <input name="odometerKm" type="number" defaultValue={initial.odometerKm} className={field} />
          {err.odometerKm && <span className="text-xs text-stop">{err.odometerKm}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-fog">Grade</span>
          <select name="grade" defaultValue={initial.grade ?? "A"} className={field}>
            {["A", "B", "C", "D", "E"].map((g) => <option key={g}>{g}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs text-fog">Color</span>
          <input name="color" defaultValue={initial.color} className={field} /></label>
      </div>

      <label className="block space-y-1"><span className="text-xs text-fog">Mechanical notes</span>
        <textarea name="mechanicalNotes" defaultValue={initial.mechanicalNotes} className={field} /></label>
      <label className="block space-y-1"><span className="text-xs text-fog">Appraisal notes</span>
        <textarea name="appraisalNotes" defaultValue={initial.appraisalNotes} className={field} /></label>

      <div className="grid grid-cols-3 gap-3">
        <label className="space-y-1"><span className="text-xs text-fog">Starting ($)</span>
          <input name="startingPrice" type="number" defaultValue={initial.startingPrice} className={field} />
          {err.startingPrice && <span className="text-xs text-stop">{err.startingPrice}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-fog">Reserve ($)</span>
          <input name="reservePrice" type="number" defaultValue={initial.reservePrice} className={field} />
          {err.reservePrice && <span className="text-xs text-stop">{err.reservePrice}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-fog">Buy now ($, optional)</span>
          <input name="buyNowPrice" type="number" defaultValue={initial.buyNowPrice} className={field} />
          {err.buyNowPrice && <span className="text-xs text-stop">{err.buyNowPrice}</span>}</label>
      </div>

      <label className="block space-y-1"><span className="text-xs text-fog">Auction ends</span>
        <EndTimeField defaultUtc={initial.endTime} className={field} />
        {err.endTime && <span className="text-xs text-stop">{err.endTime}</span>}</label>

      <div className="space-y-1"><span className="text-xs text-fog">Photos</span>
        <PhotoUploader initial={initial.photoUrls} />
        {err.photoUrls && <span className="text-xs text-stop">{err.photoUrls}</span>}</div>

      <button type="submit" disabled={pending}
        className="rounded-md bg-signal px-4 py-2 font-semibold text-ink transition-colors hover:bg-signal/90 disabled:opacity-50">
        {pending ? "Saving…" : submitLabel}</button>
    </form>
  );
}

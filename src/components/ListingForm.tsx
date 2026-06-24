"use client";

import { useActionState } from "react";
import { PhotoUploader } from "./PhotoUploader";
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
  const field = "w-full rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-white";

  return (
    <form action={formAction} className="space-y-4 max-w-xl">
      {initial.auctionId && <input type="hidden" name="auctionId" value={initial.auctionId} />}
      {err._form && <p className="text-red-400 text-sm">{err._form}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1"><span className="text-xs text-zinc-400">Make</span>
          <input name="make" defaultValue={initial.make} className={field} />
          {err.make && <span className="text-xs text-red-400">{err.make}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Model</span>
          <input name="model" defaultValue={initial.model} className={field} />
          {err.model && <span className="text-xs text-red-400">{err.model}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Year</span>
          <input name="year" type="number" defaultValue={initial.year} className={field} />
          {err.year && <span className="text-xs text-red-400">{err.year}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Variant</span>
          <input name="variant" defaultValue={initial.variant} className={field} /></label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Odometer (km)</span>
          <input name="odometerKm" type="number" defaultValue={initial.odometerKm} className={field} />
          {err.odometerKm && <span className="text-xs text-red-400">{err.odometerKm}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Grade</span>
          <select name="grade" defaultValue={initial.grade ?? "A"} className={field}>
            {["A", "B", "C", "D", "E"].map((g) => <option key={g}>{g}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Color</span>
          <input name="color" defaultValue={initial.color} className={field} /></label>
      </div>

      <label className="block space-y-1"><span className="text-xs text-zinc-400">Mechanical notes</span>
        <textarea name="mechanicalNotes" defaultValue={initial.mechanicalNotes} className={field} /></label>
      <label className="block space-y-1"><span className="text-xs text-zinc-400">Appraisal notes</span>
        <textarea name="appraisalNotes" defaultValue={initial.appraisalNotes} className={field} /></label>

      <div className="grid grid-cols-3 gap-3">
        <label className="space-y-1"><span className="text-xs text-zinc-400">Starting ($)</span>
          <input name="startingPrice" type="number" defaultValue={initial.startingPrice} className={field} />
          {err.startingPrice && <span className="text-xs text-red-400">{err.startingPrice}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Reserve ($)</span>
          <input name="reservePrice" type="number" defaultValue={initial.reservePrice} className={field} />
          {err.reservePrice && <span className="text-xs text-red-400">{err.reservePrice}</span>}</label>
        <label className="space-y-1"><span className="text-xs text-zinc-400">Buy now ($, optional)</span>
          <input name="buyNowPrice" type="number" defaultValue={initial.buyNowPrice} className={field} />
          {err.buyNowPrice && <span className="text-xs text-red-400">{err.buyNowPrice}</span>}</label>
      </div>

      <label className="block space-y-1"><span className="text-xs text-zinc-400">Auction ends</span>
        <input name="endTime" type="datetime-local" defaultValue={initial.endTime} className={field} />
        {err.endTime && <span className="text-xs text-red-400">{err.endTime}</span>}</label>

      <div className="space-y-1"><span className="text-xs text-zinc-400">Photos</span>
        <PhotoUploader initial={initial.photoUrls} />
        {err.photoUrls && <span className="text-xs text-red-400">{err.photoUrls}</span>}</div>

      <button type="submit" disabled={pending}
        className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-semibold text-white disabled:opacity-50">
        {pending ? "Saving…" : submitLabel}</button>
    </form>
  );
}

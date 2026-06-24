export interface ListingInput {
  make: string; model: string; year: number; variant: string;
  odometerKm: number; grade: "A" | "B" | "C" | "D" | "E"; color: string;
  mechanicalNotes: string; appraisalNotes: string; photoUrls: string[];
  startingPrice: number; reservePrice: number; buyNowPrice: number | null;
  endTime: string; // ISO 8601
}

export type ValidationErrors = Partial<Record<keyof ListingInput, string>>;

const DAY = 86_400_000;

export function validateListing(i: ListingInput, nowMs: number = Date.now()): ValidationErrors {
  const e: ValidationErrors = {};
  const yearMax = new Date(nowMs).getFullYear() + 1;

  if (!i.make?.trim()) e.make = "Make is required";
  if (!i.model?.trim()) e.model = "Model is required";
  if (!Number.isInteger(i.year) || i.year < 1980 || i.year > yearMax)
    e.year = `Year must be between 1980 and ${yearMax}`;
  if (!Number.isInteger(i.odometerKm) || i.odometerKm < 0)
    e.odometerKm = "Odometer must be 0 or more";
  if (!["A", "B", "C", "D", "E"].includes(i.grade)) e.grade = "Grade must be A–E";

  if (!Number.isInteger(i.startingPrice) || i.startingPrice <= 0)
    e.startingPrice = "Starting price must be greater than 0";
  if (!Number.isInteger(i.reservePrice) || i.reservePrice < i.startingPrice)
    e.reservePrice = "Reserve must be at least the starting price";
  if (i.buyNowPrice !== null && (!Number.isInteger(i.buyNowPrice) || i.buyNowPrice <= i.reservePrice))
    e.buyNowPrice = "Buy-now must be greater than the reserve";

  const end = Date.parse(i.endTime);
  if (Number.isNaN(end)) e.endTime = "Choose an end date and time";
  else if (end <= nowMs) e.endTime = "End time must be in the future";
  else if (end > nowMs + 30 * DAY) e.endTime = "End time must be within 30 days";

  const n = i.photoUrls?.length ?? 0;
  if (n < 1) e.photoUrls = "Add at least one photo";
  else if (n > 12) e.photoUrls = "No more than 12 photos";

  return e;
}

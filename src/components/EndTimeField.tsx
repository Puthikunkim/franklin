"use client";

import { useEffect, useState } from "react";
import { utcToLocalInput } from "@/lib/datetime";

// datetime-local is timezone-naive and interpreted in the browser's local zone.
// Initial render is always empty (deterministic across SSR/hydration); after mount
// we fill the field from the stored UTC value using the browser's offset, so edit
// prefills show the dealer's local time rather than a UTC-shifted value.
export function EndTimeField({ defaultUtc, className }: { defaultUtc?: string; className?: string }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (defaultUtc) setValue(utcToLocalInput(defaultUtc));
  }, [defaultUtc]);

  return (
    <input
      name="endTime"
      type="datetime-local"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className={className}
    />
  );
}

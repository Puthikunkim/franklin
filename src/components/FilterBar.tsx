"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { REGIONS, SORT_OPTIONS } from "@/lib/discovery";

const GRADES = ["A", "B", "C", "D", "E"];
const inputClass =
  "rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-chalk placeholder-fog focus:border-signal focus:outline-none";

export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Free-text / numeric inputs are controlled local state so "Clear" can reset
  // them; selects/toggles read `params` directly and reset on navigation.
  const [q, setQ] = useState(params.get("q") ?? "");
  const [min, setMin] = useState(params.get("min") ?? "");
  const [max, setMax] = useState(params.get("max") ?? "");

  const grades = (params.get("grade") ?? "").split(",").filter(Boolean);

  // Build the next URL from the LIVE query string (window.location), not a
  // closed-over `params` snapshot, so a change made during the debounce window
  // (or between rapid clicks) is never clobbered.
  function commit(overrides: Record<string, string>) {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(overrides)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Debounce the free-text/numeric fields → URL, reading live params at fire time.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => commit({ q: q.trim(), min: min.trim(), max: max.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, min, max]);

  function toggleGrade(g: string) {
    const cur = (new URLSearchParams(window.location.search).get("grade") ?? "")
      .split(",")
      .filter(Boolean);
    const next = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
    commit({ grade: next.join(",") });
  }

  function clearAll() {
    setQ("");
    setMin("");
    setMax("");
    router.replace(pathname, { scroll: false });
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <input
        type="search"
        placeholder="Search make, model, variant"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={`${inputClass} w-56`}
      />

      <div className="flex items-center gap-1">
        {GRADES.map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={grades.includes(g)}
            onClick={() => toggleGrade(g)}
            className={`rounded-md px-2.5 py-1 font-mono text-sm font-semibold transition-colors ${
              grades.includes(g)
                ? "bg-signal text-ink"
                : "border border-line bg-panel text-fog hover:text-chalk"
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <input
        type="number"
        min="0"
        placeholder="Min $"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        className={`${inputClass} w-24`}
      />
      <input
        type="number"
        min="0"
        placeholder="Max $"
        value={max}
        onChange={(e) => setMax(e.target.value)}
        className={`${inputClass} w-24`}
      />

      <select
        value={params.get("region") ?? ""}
        onChange={(e) => commit({ region: e.target.value })}
        className={inputClass}
      >
        <option value="">All regions</option>
        {REGIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      <select
        value={params.get("sort") ?? "ending_soon"}
        onChange={(e) => commit({ sort: e.target.value === "ending_soon" ? "" : e.target.value })}
        className={inputClass}
      >
        {SORT_OPTIONS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={clearAll}
        className="text-sm text-fog transition-colors hover:text-chalk"
      >
        Clear
      </button>
    </div>
  );
}

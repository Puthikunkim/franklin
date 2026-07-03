"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { REGIONS, SORT_OPTIONS } from "@/lib/discovery";

const GRADES = ["A", "B", "C", "D", "E"];
const inputClass =
  "rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100";

export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [q, setQ] = useState(params.get("q") ?? "");
  const grades = (params.get("grade") ?? "").split(",").filter(Boolean);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Debounce the text search → ?q=. Skip the first run (initial mount).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setParam("q", q.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function toggleGrade(g: string) {
    const next = grades.includes(g) ? grades.filter((x) => x !== g) : [...grades, g];
    setParam("grade", next.join(","));
  }

  function clearAll() {
    setQ("");
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
            className={`rounded px-2 py-1 text-sm ${
              grades.includes(g)
                ? "bg-emerald-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
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
        defaultValue={params.get("min") ?? ""}
        onChange={(e) => setParam("min", e.target.value)}
        className={`${inputClass} w-24`}
      />
      <input
        type="number"
        min="0"
        placeholder="Max $"
        defaultValue={params.get("max") ?? ""}
        onChange={(e) => setParam("max", e.target.value)}
        className={`${inputClass} w-24`}
      />

      <select
        value={params.get("region") ?? ""}
        onChange={(e) => setParam("region", e.target.value)}
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
        onChange={(e) => setParam("sort", e.target.value === "ending_soon" ? "" : e.target.value)}
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
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
        Clear
      </button>
    </div>
  );
}

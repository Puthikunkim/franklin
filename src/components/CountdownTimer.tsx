"use client";
import { useEffect, useState } from "react";

export function CountdownTimer({ endTime }: { endTime: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null) {
    return <span className="font-mono tabular-nums text-fog">--:--</span>;
  }
  const ms = Math.max(0, new Date(endTime).getTime() - now);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (
    <span
      className={`font-mono font-semibold tabular-nums ${
        ms < 60000 ? "text-stop" : "text-signal"
      }`}
    >
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

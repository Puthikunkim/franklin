"use client";

import { useState } from "react";

export function PhotoUploader({ initial = [] }: { initial?: string[] }) {
  const [urls, setUrls] = useState<string[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setError(null);
    setBusy(true);
    try {
      for (const file of files) {
        const presign = await fetch("/api/uploads/presign", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
        });
        if (!presign.ok) {
          const b = await presign.json().catch(() => ({}));
          setError(b.error === "r2_not_configured" ? "Photo uploads aren't configured." : "Upload rejected.");
          continue;
        }
        const { uploadUrl, publicUrl } = await presign.json();
        const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
        if (!put.ok) { setError("Upload failed, try again."); continue; }
        setUrls((prev) => [...prev, publicUrl]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {urls.map((u) => (
        <input key={u} type="hidden" name="photoUrls" value={u} />
      ))}
      <div className="flex flex-wrap gap-2">
        {urls.map((u) => (
          <div key={u} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="h-20 w-20 rounded object-cover border border-line" />
            <button type="button" onClick={() => setUrls((p) => p.filter((x) => x !== u))}
              className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-stop text-xs font-bold text-ink">×</button>
          </div>
        ))}
      </div>
      <input type="file" accept="image/*" multiple onChange={onSelect} disabled={busy}
        className="text-sm text-fog file:mr-3 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-chalk" />
      {busy && <p className="text-xs text-fog">Uploading…</p>}
      {error && <p className="text-xs text-stop">{error}</p>}
    </div>
  );
}

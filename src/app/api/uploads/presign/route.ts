import { NextResponse } from "next/server";
import { getDealerId } from "@/lib/session";
import { r2Configured, presignUpload, publicUrl } from "@/lib/r2";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const dealerId = await getDealerId();
  if (!dealerId) return NextResponse.json({ error: "no_dealer" }, { status: 401 });
  if (!r2Configured()) return NextResponse.json({ error: "r2_not_configured" }, { status: 503 });

  let body: { filename?: unknown; contentType?: unknown; size?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }

  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const size = Number(body.size);
  const filename = typeof body.filename === "string" ? body.filename : "upload";
  if (!contentType.startsWith("image/")) return NextResponse.json({ error: "invalid_file" }, { status: 400 });
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES)
    return NextResponse.json({ error: "invalid_file" }, { status: 400 });

  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  const key = `listings/${crypto.randomUUID()}-${safe}`;
  const uploadUrl = await presignUpload(key, contentType);
  return NextResponse.json({ uploadUrl, publicUrl: publicUrl(key) });
}

import { NextResponse } from "next/server";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const dealerId = await getDealerId();
  if (!dealerId) return NextResponse.json({ error: "no_dealer" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { auctionId, maxAmount } = (body ?? {}) as {
    auctionId?: unknown;
    maxAmount?: unknown;
  };

  if (!auctionId || typeof auctionId !== "string" || auctionId.trim() === "") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const coercedAmount = Number(maxAmount);
  if (!Number.isFinite(coercedAmount) || coercedAmount <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const sb = await serverClient();
  const { data, error } = await sb.rpc("place_bid", {
    p_auction_id: auctionId,
    p_dealer_id: dealerId,
    p_max_amount: coercedAmount,
  });

  if (error) {
    // Don't leak Postgres internals to the client; log server-side instead.
    console.error("place_bid RPC error:", error);
    return NextResponse.json({ error: "bid_failed" }, { status: 500 });
  }
  if (!data || (data as unknown[]).length === 0)
    return NextResponse.json({ status: "rejected", reason: "no_result" }, { status: 500 });

  return NextResponse.json((data as unknown[])[0]);
}

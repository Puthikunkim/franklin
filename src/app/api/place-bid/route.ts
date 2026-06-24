import { NextResponse } from "next/server";
import { getDealerId } from "@/lib/session";
import { serverClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const dealerId = await getDealerId();
  if (!dealerId) return NextResponse.json({ error: "no_dealer" }, { status: 401 });

  const { auctionId, maxAmount } = await req.json();
  const sb = await serverClient();
  const { data, error } = await sb.rpc("place_bid", {
    p_auction_id: auctionId,
    p_dealer_id: dealerId,
    p_max_amount: maxAmount,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || (data as unknown[]).length === 0)
    return NextResponse.json({ status: "rejected", reason: "no_result" }, { status: 500 });

  return NextResponse.json((data as unknown[])[0]);
}

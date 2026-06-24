import { cookies } from "next/headers";

export async function getDealerId(): Promise<string | null> {
  return (await cookies()).get("dealer_id")?.value ?? null;
}

export async function setDealerId(id: string): Promise<void> {
  (await cookies()).set("dealer_id", id, { httpOnly: true, sameSite: "lax", path: "/" });
}

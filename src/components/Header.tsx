import Link from "next/link";
import { getDealerId } from "@/lib/session";

export async function Header() {
  const dealerId = await getDealerId();
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <Link href="/" className="font-semibold text-white">Wholesale Dealer Auctions</Link>
      {dealerId && (
        <Link href="/sell" className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
          Sell a vehicle
        </Link>
      )}
    </header>
  );
}

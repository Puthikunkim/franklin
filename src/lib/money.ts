export function formatNZD(cents: number): string {
  const dollars = Math.round(cents / 100);
  return "$" + dollars.toLocaleString("en-NZ");
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

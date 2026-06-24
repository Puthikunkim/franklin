export function formatNZD(cents: number): string {
  // Whole-dollar amounts render cleanly ("$6,000"); any stray cents are shown
  // in full ("$6,000.50") rather than silently rounded away — this is money.
  const fractionDigits = cents % 100 === 0 ? 0 : 2;
  return (
    "$" +
    (cents / 100).toLocaleString("en-NZ", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
  );
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

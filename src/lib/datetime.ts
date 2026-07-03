// Convert a stored UTC ISO timestamp to the value a <input type="datetime-local">
// expects: local wall-clock "YYYY-MM-DDTHH:mm". The input is timezone-naive and is
// interpreted in the browser's local zone, so this MUST run client-side (the offset
// is the browser's). Returns "" for missing/invalid input.
export function utcToLocalInput(utcIso: string | null | undefined): string {
  if (!utcIso) return "";
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

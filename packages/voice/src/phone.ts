/**
 * Indian phone normalisation to E.164. Handles the forms seen in Dograh data:
 * "9876543210", "09876543210", "919876543210", "+91 98765 43210" and the
 * doubled country code "91919876543210" that Vobiz alias rows carry.
 */
export function toE164(raw: string | null | undefined, defaultCc = "91"): string | null {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith("+");
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  if (!hasPlus) {
    if (d.length === 14 && d.startsWith(`${defaultCc}${defaultCc}`)) d = d.slice(2);
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10) d = `${defaultCc}${d}`;
  }
  if (d.length < 8 || d.length > 15 || d.startsWith("0")) return null;
  return `+${d}`;
}

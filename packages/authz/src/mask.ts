/**
 * Phone masking (Blueprint Part 3): show only the last 4 digits unless the
 * viewer holds contacts:reveal_phone. Keeps the country code for context.
 *   maskPhone("+919876543210") -> "+91 ••••• •3210"
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "••••";
  const last4 = digits.slice(-4);
  const cc = phone.trim().startsWith("+") && digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "";
  return `${cc}••••• •${last4}`;
}

export function phoneFor(canReveal: boolean, phone: string | null | undefined): string {
  return canReveal ? (phone ?? "") : maskPhone(phone);
}

/** Masks an email to its first letter and domain: s•••@example.com */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [user, domain] = email.split("@");
  if (!user || !domain) return "•••";
  return `${user[0]}•••@${domain}`;
}

/**
 * The kinds of cyber crime the helpline hears, and how the call analyser's
 * free-text fraud type maps onto them. Analytics groups complaints by these.
 */

export const SCAM_TYPES = [
  { key: "upi_bank_card", label: "UPI, bank or card fraud", money: true, category: "financial" },
  { key: "fake_customer_care_kyc_apk", label: "Fake customer care, KYC or APK", money: true, category: "financial" },
  { key: "digital_arrest", label: "Digital arrest (fake police, CBI, customs)", money: true, category: "financial" },
  { key: "investment_trading", label: "Investment, trading or crypto", money: true, category: "financial" },
  { key: "part_time_job_task", label: "Part-time job or task scam", money: true, category: "financial" },
  { key: "sextortion", label: "Sextortion or video call blackmail", money: false, category: "social_media" },
  { key: "loan_app", label: "Loan app harassment", money: false, category: "financial" },
  { key: "social_media_hack_fake_profile", label: "Hacked account or fake profile", money: false, category: "social_media" },
  { key: "online_shopping_fake_booking", label: "Fake shopping, website or booking", money: true, category: "financial" },
  { key: "lottery_gift_romance", label: "Lottery, gift or romance scam", money: true, category: "financial" },
  { key: "sim_swap_aeps", label: "SIM swap or Aadhaar (AePS) withdrawal", money: true, category: "financial" },
  { key: "account_frozen", label: "Bank account frozen by a cyber cell", money: false, category: "account_frozen" },
  { key: "online_harassment", label: "Online harassment, stalking or threats", money: false, category: "social_media" },
  { key: "hacking_ransomware", label: "Hacking, ransomware or email fraud", money: true, category: "financial" },
  { key: "other", label: "Other cyber crime", money: false, category: "other" },
] as const;
export type ScamType = (typeof SCAM_TYPES)[number]["key"];

/**
 * The four main categories the department reads its complaints by. Every scam type
 * belongs to one; a complaint whose type is not clear yet counts under Other.
 */
export const SCAM_CATEGORIES = [
  { key: "financial", label: "Financial scams" },
  { key: "social_media", label: "Social media" },
  { key: "account_frozen", label: "Bank account frozen" },
  { key: "other", label: "Other" },
] as const;
export type ScamCategory = (typeof SCAM_CATEGORIES)[number]["key"];

export function categoryOf(scam: string | null | undefined): ScamCategory {
  return SCAM_TYPES.find((s) => s.key === scam)?.category ?? "other";
}

export function categoryLabel(key: string | null | undefined): string {
  return SCAM_CATEGORIES.find((c) => c.key === key)?.label ?? "Other";
}

export function scamLabel(key: string | null | undefined): string {
  return SCAM_TYPES.find((s) => s.key === key)?.label ?? (key ? key : "Not known yet");
}

/** Maps the call analyser's free-text fraud type onto a catalogue key. */
export function scamKeyFromText(text: string | null | undefined): ScamType | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const rules: Array<[RegExp, ScamType]> = [
    [/digital arrest|cbi|customs|\bed\b|narcotics|parcel/, "digital_arrest"],
    [/sextort|blackmail|intimate|nude|morph/, "sextortion"],
    [/loan app|loan-app|instant loan/, "loan_app"],
    [/freez|frozen|hold|lien|debit freeze|blocked account/, "account_frozen"],
    [/invest|trading|stock|ipo|crypto|bitcoin/, "investment_trading"],
    [/part.?time|task|job|work from home|youtube like|review/, "part_time_job_task"],
    [/kyc|customer care|apk|anydesk|teamviewer|screen shar|electricity/, "fake_customer_care_kyc_apk"],
    // Ransomware and email fraud before "hack", or "hacking/ransomware" would read as a hacked profile.
    [/ransom|malware|email fraud|business email/, "hacking_ransomware"],
    [/hack|fake profile|impersonat|social media|instagram|facebook|whatsapp hack/, "social_media_hack_fake_profile"],
    [/shopping|olx|marketplace|website|booking|helicopter|hotel|delivery/, "online_shopping_fake_booking"],
    [/lottery|prize|gift|romance|matrimon|dating|kbc/, "lottery_gift_romance"],
    [/sim swap|esim|aeps|aadhaar|fingerprint/, "sim_swap_aeps"],
    [/harass|stalk|threat|defam|abuse/, "online_harassment"],
    [/upi|bank|card|debit|credit|otp|qr|transaction|money/, "upi_bank_card"],
  ];
  for (const [re, key] of rules) if (re.test(t)) return key;
  return SCAM_TYPES.some((s) => s.key === t) ? (t as ScamType) : "other";
}

/** The analyser's label for a call that turned out not to be a cyber crime (a theft, a family dispute). */
export function isNotCyberCrime(text: string | null | undefined): boolean {
  return /\bnot\s+(a\s+)?cyber\s*crime\b/i.test(String(text ?? ""));
}

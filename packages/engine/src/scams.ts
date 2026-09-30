/**
 * The kinds of cyber crime the helpline hears, and how the call analyser's
 * free-text fraud type maps onto them. Analytics groups complaints by these.
 */

export const SCAM_TYPES = [
  { key: "upi_bank_card", label: "UPI, bank or card fraud", money: true },
  { key: "fake_customer_care_kyc_apk", label: "Fake customer care, KYC or APK", money: true },
  { key: "digital_arrest", label: "Digital arrest (fake police, CBI, customs)", money: true },
  { key: "investment_trading", label: "Investment, trading or crypto", money: true },
  { key: "part_time_job_task", label: "Part-time job or task scam", money: true },
  { key: "sextortion", label: "Sextortion or video call blackmail", money: false },
  { key: "loan_app", label: "Loan app harassment", money: false },
  { key: "social_media_hack_fake_profile", label: "Hacked account or fake profile", money: false },
  { key: "online_shopping_fake_booking", label: "Fake shopping, website or booking", money: true },
  { key: "lottery_gift_romance", label: "Lottery, gift or romance scam", money: true },
  { key: "sim_swap_aeps", label: "SIM swap or Aadhaar (AePS) withdrawal", money: true },
  { key: "account_frozen", label: "Bank account frozen by a cyber cell", money: false },
  { key: "online_harassment", label: "Online harassment, stalking or threats", money: false },
  { key: "hacking_ransomware", label: "Hacking, ransomware or email fraud", money: true },
  { key: "other", label: "Other cyber crime", money: false },
] as const;
export type ScamType = (typeof SCAM_TYPES)[number]["key"];

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
    [/hack|fake profile|impersonat|social media|instagram|facebook|whatsapp hack/, "social_media_hack_fake_profile"],
    [/shopping|olx|marketplace|website|booking|helicopter|hotel|delivery/, "online_shopping_fake_booking"],
    [/lottery|prize|gift|romance|matrimon|dating|kbc/, "lottery_gift_romance"],
    [/sim swap|esim|aeps|aadhaar|fingerprint/, "sim_swap_aeps"],
    [/harass|stalk|threat|defam|abuse/, "online_harassment"],
    [/ransom|malware|email fraud|business email/, "hacking_ransomware"],
    [/upi|bank|card|debit|credit|otp|qr|transaction|money/, "upi_bank_card"],
  ];
  for (const [re, key] of rules) if (re.test(t)) return key;
  return SCAM_TYPES.some((s) => s.key === t) ? (t as ScamType) : "other";
}

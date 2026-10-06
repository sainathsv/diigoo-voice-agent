/**
 * What a cyber crime case must contain before officers get it, and how the
 * complainant is asked for each piece on WhatsApp. The call takes a few simple
 * answers and the caller's permission; for a money fraud WhatsApp then takes the
 * department's form, one line at a time in the form's own order, with the proof.
 * Code decides WHAT to ask next and checks the shape of every answer; the model
 * only reads the replies, so it can never invent a question or skip an item.
 * Keys are the call program's, so a call and its WhatsApp answers merge as one.
 */
import { SCAM_TYPES } from "../scams";
import { UTTARAKHAND_PINCODES } from "./pincodes-uttarakhand";

/** Asked first when a case starts on WhatsApp with nothing known yet. */
export const OPENING_REQUIRED = ["how_it_happened", "scam_type"] as const;

/**
 * The department's complaint form for a money fraud, in the order WhatsApp asks it. The police
 * station and district come from the PIN code and are only confirmed ("location_check"); for a
 * PIN code not in the list they are asked instead.
 */
export const FINANCIAL_REQUIRED = [
  "complainant_name",
  "father_or_husband_name",
  "date_of_birth",
  "house_number",
  "present_address",
  "pincode",
  "location_check",
  "victim_bank_and_account",
  "card_last4",
  "transactions",
  "money_lost",
  "how_it_happened",
  "fraudster_details",
  "apk_or_link",
  "proof",
] as const;

/** "fraudster_details" is answered by any one of these (one question; the reader splits the answer). */
export const FRAUDSTER_KEYS = ["fraudster_mobile", "fraudster_whatsapp", "suspect_account_or_upi", "suspect_social_media", "suspect_email"] as const;

/** Items a complainant may honestly not know; "not known" then counts as an answer. */
const MAY_BE_UNKNOWN = new Set(["house_number", "police_station", "pincode", "card_last4", "fraudster_details"]);
export const mayBeUnknown = (key: string) => MAY_BE_UNKNOWN.has(key);

export const FIELD_LABELS: Record<string, string> = {
  mobile_number: "Mobile number",
  how_it_happened: "How the fraud happened",
  scam_type: "Type of fraud",
  complainant_name: "Name",
  father_or_husband_name: "Father's / husband's name",
  date_of_birth: "Date of birth",
  house_number: "House number",
  present_address: "Present address",
  police_station: "Police station",
  district: "District",
  pincode: "PIN code",
  location_check: "Police station and district (from the PIN code)",
  victim_bank_and_account: "Bank and account the money left from",
  card_last4: "Card (last 4 digits)",
  transactions: "Transactions (UPI / UTR numbers)",
  money_lost: "Total amount lost",
  fraudster_details: "Fraudster's number, UPI ID, account or profile",
  apk_or_link: "APK file or link",
  proof: "Proof (screenshots)",
};

type Lang = "hi" | "en" | "ne";

const SHORT: Record<string, Record<Lang, string>> = {
  mobile_number: { hi: "मोबाइल नंबर", en: "mobile number", ne: "मोबाइल नम्बर" },
  location_check: { hi: "थाना और जनपद की पुष्टि", en: "your police station and district", ne: "प्रहरी चौकी र जिल्लाको पुष्टि" },
  how_it_happened: { hi: "घटना का विवरण", en: "what happened", ne: "घटनाको विवरण" },
  scam_type: { hi: "फ्रॉड का प्रकार", en: "type of fraud", ne: "ठगीको प्रकार" },
  complainant_name: { hi: "आपका नाम", en: "your name", ne: "तपाईंको नाम" },
  father_or_husband_name: { hi: "पिता/पति का नाम", en: "father's or husband's name", ne: "बुबा/श्रीमानको नाम" },
  date_of_birth: { hi: "जन्म तिथि", en: "date of birth", ne: "जन्म मिति" },
  house_number: { hi: "मकान नंबर", en: "house number", ne: "घर नम्बर" },
  present_address: { hi: "वर्तमान पता", en: "present address", ne: "हालको ठेगाना" },
  police_station: { hi: "पुलिस स्टेशन", en: "police station", ne: "प्रहरी चौकी" },
  district: { hi: "जनपद", en: "district", ne: "जिल्ला" },
  pincode: { hi: "पिनकोड", en: "PIN code", ne: "पिनकोड" },
  victim_bank_and_account: { hi: "बैंक नाम व खाता संख्या", en: "bank and account number", ne: "बैंक र खाता नम्बर" },
  card_last4: { hi: "कार्ड के आख़िरी 4 अंक", en: "last 4 digits of the card", ne: "कार्डका अन्तिम ४ अंक" },
  transactions: { hi: "ट्रांजेक्शन के UTR नंबर", en: "transaction UTR numbers", ne: "कारोबारको UTR नम्बर" },
  money_lost: { hi: "कुल राशि", en: "total amount", ne: "जम्मा रकम" },
  fraudster_details: { hi: "फ्रॉड करने वाले की जानकारी", en: "the fraudster's details", ne: "ठगको विवरण" },
  apk_or_link: { hi: "APK/लिंक की जानकारी", en: "APK or link", ne: "APK/लिंक" },
  proof: { hi: "सबूत (स्क्रीनशॉट)", en: "proof (screenshots)", ne: "प्रमाण (स्क्रिनसट)" },
};

const Q: Record<string, Record<Lang, string>> = {
  mobile_number: {
    hi: "WhatsApp पर हमें आपका नंबर नहीं दिखता। कृपया अपना मोबाइल नंबर भेजें (10 अंक)।",
    en: "WhatsApp does not show us your number. Please send your mobile number (10 digits).",
    ne: "WhatsApp मा हामीलाई तपाईंको नम्बर देखिँदैन। कृपया आफ्नो मोबाइल नम्बर पठाउनुहोस् (१० अंक)।",
  },
  how_it_happened: {
    hi: "कृपया संक्षेप में बताइए कि आपके साथ क्या हुआ।",
    en: "Please tell us briefly what happened.",
    ne: "कृपया तपाईंलाई के भयो छोटकरीमा बताउनुहोस्।",
  },
  scam_type: {
    hi: "यह किस तरह का फ्रॉड था? (जैसे UPI/बैंक, नौकरी/टास्क, निवेश, डिजिटल अरेस्ट, लोन ऐप, फर्जी प्रोफाइल)",
    en: "What kind of fraud was it? (for example UPI/bank, job/task, investment, digital arrest, loan app, fake profile)",
    ne: "यो कस्तो किसिमको ठगी थियो? (जस्तै UPI/बैंक, जागिर/टास्क, लगानी, डिजिटल अरेस्ट, लोन एप, नक्कली प्रोफाइल)",
  },
  complainant_name: {
    hi: "1. आपका पूरा नाम क्या है? (जैसा आधार कार्ड में है, English अक्षरों में)",
    en: "1. What is your full name? (as on your Aadhaar card)",
    ne: "१. तपाईंको पूरा नाम के हो? (आधार कार्डमा जस्तै, English अक्षरमा)",
  },
  father_or_husband_name: {
    hi: "2. आपके पिता या पति का नाम क्या है?",
    en: "2. What is your father's or husband's name?",
    ne: "२. तपाईंको बुबा वा श्रीमानको नाम के हो?",
  },
  date_of_birth: {
    hi: "3. आपकी जन्म तिथि क्या है? (दिन/महीना/साल, जैसे 15/08/1990)",
    en: "3. What is your date of birth? (day/month/year, for example 15/08/1990)",
    ne: "३. तपाईंको जन्म मिति के हो? (दिन/महिना/साल, जस्तै 15/08/1990)",
  },
  house_number: {
    hi: "4. आपका मकान नंबर क्या है?",
    en: "4. What is your house number?",
    ne: "४. तपाईंको घर नम्बर के हो?",
  },
  present_address: {
    hi: "5. आपका वर्तमान पता क्या है, जहाँ आप अभी रह रहे हैं? (गली/मोहल्ला, शहर/गाँव)",
    en: "5. What is your present address, where you live now? (street or locality, town or village)",
    ne: "५. तपाईं अहिले बस्ने हालको ठेगाना के हो? (टोल, सहर/गाउँ)",
  },
  police_station: {
    hi: "आपका पुलिस स्टेशन (थाना) कौन सा है?",
    en: "Which is your police station?",
    ne: "तपाईंको प्रहरी चौकी कुन हो?",
  },
  district: {
    hi: "आपका जनपद (जिला) कौन सा है?",
    en: "Which is your district?",
    ne: "तपाईंको जिल्ला कुन हो?",
  },
  pincode: {
    hi: "6. आपके क्षेत्र का पिनकोड क्या है? (6 अंक)",
    en: "6. What is your PIN code? (6 digits)",
    ne: "६. तपाईंको क्षेत्रको पिनकोड के हो? (६ अंक)",
  },
  victim_bank_and_account: {
    hi: "8. आपका बैंक नाम और खाता संख्या क्या है, जिससे पैसे कटे हैं?",
    en: "8. Which bank, and which account number, did the money leave from?",
    ne: "८. पैसा काटिएको बैंकको नाम र खाता नम्बर के हो?",
  },
  card_last4: {
    hi: "9. अगर कार्ड से फ्रॉड हुआ है, तो कार्ड के सिर्फ़ आख़िरी 4 अंक भेजें। पूरा नंबर, CVV या PIN कभी न भेजें।",
    en: "9. If a card was used, send ONLY the last 4 digits of the card. Never send the full number, CVV or PIN.",
    ne: "९. कार्डबाट ठगी भएको भए कार्डका अन्तिम ४ अंक मात्र पठाउनुहोस्। पूरा नम्बर, CVV वा PIN कहिल्यै नपठाउनुहोस्।",
  },
  transactions: {
    hi: "10. हर ट्रांजेक्शन का UTR / UPI रेफरेंस नंबर, तारीख और रकम भेजें। (यह बैंक के SMS या UPI ऐप में मिलता है)",
    en: "10. Send the UTR / UPI reference number, date and amount of each transaction. (You will find it in the bank SMS or the UPI app)",
    ne: "१०. हरेक कारोबारको UTR / UPI रेफरेन्स नम्बर, मिति र रकम पठाउनुहोस्। (बैंकको SMS वा UPI एपमा हुन्छ)",
  },
  money_lost: {
    hi: "11. कुल कितनी राशि कटी? (रुपये में)",
    en: "11. What is the total amount lost? (in rupees)",
    ne: "११. जम्मा कति रकम गयो? (रुपैयाँमा)",
  },
  fraudster_details: {
    hi: "12. फ्रॉड करने वाले का मोबाइल नंबर, WhatsApp नंबर, जिस UPI ID या बैंक खाते में पैसे गए, सोशल मीडिया प्रोफाइल या ईमेल ID, जो भी आपके पास है, भेजें।",
    en: "12. Send whatever you have of the fraudster: mobile number, WhatsApp number, the UPI ID or bank account the money went to, social media profile or email ID.",
    ne: "१२. ठगको मोबाइल नम्बर, WhatsApp नम्बर, पैसा गएको UPI ID वा बैंक खाता, सामाजिक सञ्जाल प्रोफाइल वा इमेल ID, जे छ पठाउनुहोस्।",
  },
  apk_or_link: {
    hi: "13. क्या आपको कोई APK फ़ाइल या लिंक भेजा गया था, या आपने कोई ऐप इंस्टॉल किया? (हाँ/नहीं, और उसका नाम)",
    en: "13. Were you sent an APK file or a link, or did you install an app? (yes/no, and its name)",
    ne: "१३. के तपाईंलाई कुनै APK फाइल वा लिंक पठाइएको थियो, वा कुनै एप इन्स्टल गर्नुभयो? (हो/होइन, र त्यसको नाम)",
  },
  proof: {
    hi: "14. कृपया सबूत यहीं भेजें: ट्रांजेक्शन का स्क्रीनशॉट (UTR नंबर के साथ) और फ्रॉड वाली चैट या कॉल के स्क्रीनशॉट।",
    en: "14. Please send the proof here: the transaction screenshot (with the UTR number) and screenshots of the fraud chat or calls.",
    ne: "१४. कृपया प्रमाण यहीँ पठाउनुहोस्: कारोबारको स्क्रिनसट (UTR नम्बर सहित) र ठगीको च्याट वा कलको स्क्रिनसट।",
  },
};

/** Said before asking an item again when the reply did not fit. */
const HINT: Record<string, Record<Lang, string>> = {
  location_check: { hi: "कृपया \"हाँ\" लिखें, या अपने थाने का सही नाम लिखें।", en: "Please reply YES, or send the correct police station name.", ne: "कृपया \"हो\" लेख्नुहोस्, वा सही प्रहरी चौकीको नाम लेख्नुहोस्।" },
  mobile_number: { hi: "मोबाइल नंबर 10 अंकों का होता है, जैसे 9876543210।", en: "A mobile number has 10 digits, for example 9876543210.", ne: "मोबाइल नम्बर १० अंकको हुन्छ, जस्तै 9876543210।" },
  date_of_birth: { hi: "जन्म तिथि दिन/महीना/साल में लिखें, जैसे 15/08/1990।", en: "Please write the date as day/month/year, for example 15/08/1990.", ne: "मिति दिन/महिना/साल मा लेख्नुहोस्, जस्तै 15/08/1990।" },
  pincode: { hi: "पिनकोड 6 अंकों का होता है, जैसे 248001।", en: "A PIN code has 6 digits, for example 248001.", ne: "पिनकोड ६ अंकको हुन्छ, जस्तै 248001।" },
  transactions: { hi: "UTR / रेफरेंस नंबर 12 या उससे ज़्यादा अंकों का होता है, जो बैंक के SMS या UPI ऐप में दिखता है।", en: "The UTR / reference number has 12 or more characters; it is shown in the bank SMS or the UPI app.", ne: "UTR / रेफरेन्स नम्बर १२ वा बढी अंकको हुन्छ, बैंकको SMS वा UPI एपमा देखिन्छ।" },
  money_lost: { hi: "कृपया सिर्फ़ रकम अंकों में लिखें, जैसे 45000।", en: "Please write just the amount in figures, for example 45000.", ne: "कृपया रकम अंकमा मात्र लेख्नुहोस्, जस्तै 45000।" },
  victim_bank_and_account: { hi: "बैंक का नाम और खाता संख्या दोनों लिखें, जैसे SBI 1234567890।", en: "Please write both the bank name and the account number, for example SBI 1234567890.", ne: "बैंकको नाम र खाता नम्बर दुवै लेख्नुहोस्, जस्तै SBI 1234567890।" },
  card_last4: { hi: "सिर्फ़ 4 अंक भेजें।", en: "Please send just 4 digits.", ne: "४ अंक मात्र पठाउनुहोस्।" },
  apk_or_link: { hi: "कृपया हाँ या नहीं लिखें।", en: "Please answer yes or no.", ne: "कृपया हो वा होइन लेख्नुहोस्।" },
};
const HINT_ANY: Record<Lang, string> = { hi: "माफ़ कीजिए, यह जानकारी साफ़ नहीं मिली।", en: "Sorry, that did not come through clearly.", ne: "माफ गर्नुहोस्, यो जानकारी स्पष्ट भएन।" };

const VALID: Record<string, (v: string) => boolean> = {
  mobile_number: (v) => /^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, "")),
  complainant_name: (v) => /\p{L}{2,}/u.test(v),
  father_or_husband_name: (v) => /\p{L}{2,}/u.test(v),
  date_of_birth: (v) => /\b(19[2-9]\d|200\d|201[0-5])\b/.test(v),
  present_address: (v) => v.length >= 8,
  police_station: (v) => /\p{L}{2,}/u.test(v),
  district: (v) => /\p{L}{2,}/u.test(v),
  pincode: (v) => /^\d{6}$/.test(v.replace(/\s/g, "")),
  victim_bank_and_account: (v) => /\p{L}{2,}/u.test(v) && /\d{4,}/.test(v),
  card_last4: (v) => /^\d{4}$/.test(v.replace(/\D/g, "")),
  transactions: (v) => /[A-Za-z0-9]{10,}/.test(v.replace(/[\s-]/g, "")) && /\d{6,}/.test(v.replace(/\D/g, "")),
  money_lost: (v) => Number(v.replace(/[^\d.]/g, "")) > 0,
  how_it_happened: (v) => v.length >= 8,
  apk_or_link: (v) => /^(yes|no)\b/i.test(v),
};

const filled = (v: unknown) => String(v ?? "").trim();

/** Whether the form line has a usable answer: present, in the right shape, or honestly "not known" where allowed. */
export function answered(key: string, fields: Record<string, string>): boolean {
  if (key === "location_check") return ["yes", "corrected", "given"].includes(filled(fields.location_confirmed));
  if (key === "fraudster_details") return FRAUDSTER_KEYS.some((k) => filled(fields[k])) || /^not known$/i.test(filled(fields.fraudster_details));
  const v = filled(fields[key]);
  if (!v) return false;
  if (/^not known$/i.test(v)) return MAY_BE_UNKNOWN.has(key);
  return VALID[key]?.(v) ?? true;
}

/** Money left the complainant: the case needs the full form (otherwise the form link is sent). */
export function isFinancial(fields: Record<string, string>, scamType: string | null): boolean {
  if (fields.financial === "yes") return true; // decided from the call, before WhatsApp asks the amount again
  const moneyType = SCAM_TYPES.find((s) => s.key === scamType)?.money ?? false;
  return moneyType || Number(filled(fields.money_lost).replace(/[^\d.]/g, "")) > 0;
}

/** A card was used. Read from what happened, not the type label ("UPI/bank/card fraud" names every UPI case). */
function cardFraud(fields: Record<string, string>): boolean {
  return /\b(credit card|debit card|atm card|card number|swipe|card)\b/i.test([fields.type_details, fields.how_it_happened, fields.transactions].map(filled).join(" "));
}

/**
 * What WhatsApp must collect: the opening two while the type is unknown, the whole form for a
 * money fraud, nothing otherwise; first of all the mobile number when WhatsApp hides it.
 */
export function requiredFor(fields: Record<string, string>, scamType: string | null): string[] {
  const form =
    fields.followup === "form_link" || (scamType && !isFinancial(fields, scamType)) // the form link does the rest
      ? []
      : !scamType
        ? [...OPENING_REQUIRED]
        : FINANCIAL_REQUIRED.flatMap((k): string[] => (k === "location_check" ? locationItems(fields) : k === "card_last4" && !cardFraud(fields) ? [] : [k]));
  return fields.number_hidden === "yes" ? ["mobile_number", ...form] : form;
}

/** After the PIN code: confirm the police station and district found from it, or ask them when it is not in the list. */
function locationItems(fields: Record<string, string>): string[] {
  if (!answered("pincode", fields)) return [];
  return fields.location_from_pin && fields.location_from_pin === pinOf(fields.pincode) ? ["location_check"] : ["police_station", "district"];
}

const pinOf = (v: string | undefined) => (v ?? "").replace(/\s/g, "");

/**
 * Fills the district and the likely police station from a new Uttarakhand PIN code, for the
 * complainant to confirm or correct; a PIN code not in the list leaves them to be asked. What
 * the complainant gave themselves is kept (both given: nothing to confirm); what an earlier
 * PIN code filled in is replaced.
 */
export function withPinLocation(fields: Record<string, string>): Record<string, string> {
  const pin = pinOf(fields.pincode);
  if (!/^\d{6}$/.test(pin) || fields.location_from_pin === pin || fields.pin_not_listed === pin) return fields;
  const found = UTTARAKHAND_PINCODES[pin];
  if (!found) return { ...fields, pin_not_listed: pin };
  const own = (k: "district" | "police_station") => !fields.location_from_pin && answered(k, fields);
  if (own("district") && own("police_station")) return { ...fields, location_from_pin: pin, location_confirmed: "given" };
  const { location_confirmed: _old, ...rest } = fields; // a new PIN code is confirmed afresh
  return { ...rest, district: own("district") ? fields.district! : found[0], police_station: own("police_station") ? fields.police_station! : found[1], location_from_pin: pin };
}

/** Required items not yet answered, in the order they will be asked. */
export function missingFor(fields: Record<string, string>, scamType: string | null, evidenceCount: number): string[] {
  return requiredFor(fields, scamType).filter((k) => {
    if (k === "proof") return evidenceCount === 0;
    if (k === "scam_type") return !scamType;
    return !answered(k, fields);
  });
}

export function langOf(language: string | null | undefined): Lang {
  return language === "en" || language === "ne" ? language : "hi";
}

/**
 * Every WhatsApp message goes in two languages at once: Hindi (Nepali for someone who
 * writes in Nepali) and then English, so the complainant reads whichever they prefer.
 */
function both(text: (l: Lang) => string, language: string | null | undefined): string {
  return `${text(langOf(language) === "ne" ? "ne" : "hi")}\n\n${text("en")}`;
}

export function questionFor(field: string, language: string | null | undefined, fields: Record<string, string> = {}): string {
  if (field === "location_check") return both((l) => locationQuestionIn(fields, l), language);
  return both((l) => Q[field]?.[l] ?? Q.how_it_happened![l], language);
}

/** The police station and district found from the PIN code, for the complainant to confirm or correct. */
function locationQuestionIn(f: Record<string, string>, l: Lang): string {
  const [pin, district, ps] = [pinOf(f.pincode), f.district ?? "", f.police_station ?? ""];
  if (l === "en") return `7. By your PIN code ${pin}, your district is ${district} and your police station is likely ${ps}. Is that right? Reply YES, or send the correct police station name.`;
  if (l === "ne") return `७. तपाईंको पिनकोड ${pin} अनुसार तपाईंको जिल्ला ${district} हो र प्रहरी चौकी ${ps} हुन सक्छ। के यो ठीक हो? ठीक भए "हो" लेख्नुहोस्, नभए सही प्रहरी चौकीको नाम लेख्नुहोस्।`;
  return `7. आपके पिनकोड ${pin} के अनुसार आपका जनपद ${district} है और थाना ${ps} हो सकता है। क्या यह सही है? सही है तो "हाँ" लिखें, नहीं तो अपने थाने का सही नाम लिखें।`;
}

/** What to say before asking the same item again because the reply did not fit. */
export function hintFor(field: string, language: string | null | undefined): string {
  return both((l) => HINT[field]?.[l] ?? HINT_ANY[l], language);
}

function openerTextIn(department: string, caseNo: string, l: Lang): string {
  if (l === "en") return `Hello, this is the ${department} helpline, as agreed on your call. Your complaint number is ${caseNo}. We will ask the complaint form one question at a time; please reply here and send the screenshots here too.`;
  if (l === "ne") return `नमस्ते, यो ${department} को हेल्पलाइन हो, फोनमा भनेअनुसार। तपाईंको उजुरी नम्बर ${caseNo} हो। हामी उजुरी फारमका प्रश्न एक-एक गरी सोध्छौं; कृपया यहीँ जवाफ र स्क्रिनसट पठाउनुहोस्।`;
  return `नमस्ते, यह ${department} की हेल्पलाइन है, जैसा कॉल पर बात हुई। आपकी शिकायत संख्या ${caseNo} है। हम शिकायत फ़ॉर्म के सवाल एक-एक करके पूछेंगे; कृपया यहीं जवाब दें और स्क्रीनशॉट भी यहीं भेजें।`;
}

export function openerText(department: string, caseNo: string, language: string | null | undefined): string {
  return both((l) => openerTextIn(department, caseNo, l), language);
}

/** Someone whose complaint is still being filled in called again: WhatsApp picks up where it was. */
function callAgainTextIn(department: string, caseNo: string, l: Lang): string {
  if (l === "en") return `Hello, this is the ${department} helpline. We have received your call about complaint ${caseNo}. Let us continue it here.`;
  if (l === "ne") return `नमस्ते, यो ${department} को हेल्पलाइन हो। उजुरी ${caseNo} बारे तपाईंको फोन प्राप्त भयो। यसलाई यहीँ अगाडि बढाऔं।`;
  return `नमस्ते, यह ${department} की हेल्पलाइन है। शिकायत ${caseNo} के बारे में आपकी कॉल मिल गई। आइए इसे यहीं आगे बढ़ाते हैं।`;
}

export function callAgainText(department: string, caseNo: string, language: string | null | undefined): string {
  return both((l) => callAgainTextIn(department, caseNo, l), language);
}

/** A money fraud reported 3 or more days after the transaction: the helpline takes those through the form link. */
function lateFormLinkTextIn(department: string, caseNo: string, url: string, l: Lang): string {
  if (l === "en") return `Hello, this is the ${department} helpline. Your complaint number is ${caseNo}. This helpline takes money fraud complaints only within 3 days of the transaction. Please file your complaint at this link: ${url}`;
  if (l === "ne") return `नमस्ते, यो ${department} को हेल्पलाइन हो। तपाईंको उजुरी नम्बर ${caseNo} हो। यो हेल्पलाइनले पैसाको ठगीको उजुरी कारोबार भएको ३ दिनभित्र मात्र लिन्छ। कृपया यो लिंकमा आफ्नो उजुरी दर्ता गर्नुहोस्: ${url}`;
  return `नमस्ते, यह ${department} की हेल्पलाइन है। आपकी शिकायत संख्या ${caseNo} है। इस हेल्पलाइन पर पैसे की धोखाधड़ी की शिकायत ट्रांजेक्शन के 3 दिन के अंदर ही ली जाती है। कृपया इस लिंक पर अपनी शिकायत दर्ज करें: ${url}`;
}

export function lateFormLinkText(department: string, caseNo: string, url: string, language: string | null | undefined): string {
  return both((l) => lateFormLinkTextIn(department, caseNo, url, l), language);
}

/** To someone who writes without having called: the department's greeting, and how to file a complaint. */
function greetingTextIn(department: string, helpline: string | null, l: Lang): string {
  const number = helpline ? ` ${helpline}` : "";
  if (l === "en") return `Namaste, this is the WhatsApp of the ${department}. To report a cyber crime, please call our helpline${number}. After your call, your complaint continues here on WhatsApp. If anyone's life is in danger, call 112.`;
  if (l === "ne") return `नमस्ते, यो ${department} को WhatsApp हो। साइबर अपराधको उजुरी गर्न कृपया हाम्रो हेल्पलाइन${number} मा फोन गर्नुहोस्। फोनपछि तपाईंको उजुरी यहीँ WhatsApp मा अगाडि बढ्छ। कसैको ज्यान खतरामा छ भने 112 मा फोन गर्नुहोस्।`;
  return `नमस्ते, यह ${department} का WhatsApp है। साइबर अपराध की शिकायत के लिए कृपया हमारी हेल्पलाइन${number} पर कॉल करें। कॉल के बाद आपकी शिकायत यहीं WhatsApp पर आगे बढ़ेगी। अगर किसी की जान को खतरा है तो 112 पर कॉल करें।`;
}

export function greetingText(department: string, helpline: string | null, language: string | null | undefined): string {
  return both((l) => greetingTextIn(department, helpline, l), language);
}

/** For a complaint without money lost: the cyber team's own form. */
function formLinkTextIn(department: string, caseNo: string, url: string, l: Lang): string {
  if (l === "en") return `Hello, this is the ${department} helpline, as agreed on your call. Your complaint number is ${caseNo}. Please fill in the complaint form here: ${url}\nYou can also send screenshots in reply to this message.`;
  if (l === "ne") return `नमस्ते, यो ${department} को हेल्पलाइन हो, फोनमा भनेअनुसार। तपाईंको उजुरी नम्बर ${caseNo} हो। कृपया यहाँ उजुरी फारम भर्नुहोस्: ${url}\nस्क्रिनसट यही सन्देशको जवाफमा पनि पठाउन सक्नुहुन्छ।`;
  return `नमस्ते, यह ${department} की हेल्पलाइन है, जैसा कॉल पर बात हुई। आपकी शिकायत संख्या ${caseNo} है। कृपया यह शिकायत फ़ॉर्म भरें: ${url}\nस्क्रीनशॉट इसी मैसेज के जवाब में भी भेज सकते हैं।`;
}

export function formLinkText(department: string, caseNo: string, url: string, language: string | null | undefined): string {
  return both((l) => formLinkTextIn(department, caseNo, url, l), language);
}

function reminderTextIn(caseNo: string, missing: string[], l: Lang): string {
  const items = missing.map((k) => SHORT[k]?.[l] ?? FIELD_LABELS[k] ?? k).join(", ");
  if (l === "en") return `Reminder about complaint ${caseNo}: we still need ${items}. Your complaint goes to officers as soon as this is in. Please reply here.`;
  if (l === "ne") return `उजुरी ${caseNo} बारे सम्झना: अझै चाहिन्छ: ${items}। यो आएपछि उजुरी अधिकारीलाई पठाइन्छ। कृपया यहीँ जवाफ दिनुहोस्।`;
  return `शिकायत ${caseNo} के बारे में याद दिला रहे हैं: अभी भी चाहिए: ${items}। यह मिलते ही आपकी शिकायत अधिकारियों को भेज दी जाएगी। कृपया यहीं जवाब दें।`;
}

export function reminderText(caseNo: string, missing: string[], language: string | null | undefined): string {
  return both((l) => reminderTextIn(caseNo, missing, l), language);
}

function completeTextIn(caseNo: string, l: Lang): string {
  if (l === "en") return `Thank you. Complaint ${caseNo} is complete and has been handed to the cyber cell officers. An officer will contact you on this number. Please keep all chats and screenshots; do not delete them.`;
  if (l === "ne") return `धन्यवाद। उजुरी ${caseNo} पूरा भयो र साइबर सेलका अधिकारीलाई दिइयो। अधिकारीले यही नम्बरमा सम्पर्क गर्नुहुनेछ। सबै च्याट र स्क्रिनसट नमेटाउनुहोस्।`;
  return `धन्यवाद। शिकायत ${caseNo} पूरी हो गई है और साइबर सेल के अधिकारियों को सौंप दी गई है। अधिकारी इसी नंबर पर आपसे संपर्क करेंगे। सभी चैट और स्क्रीनशॉट संभाल कर रखें, डिलीट न करें।`;
}

/** The person behind a hidden number turned out to have a complaint open already: the chat continues it. */
function joinedTextIn(caseNo: string, l: Lang): string {
  if (l === "en") return `Thank you. We found your complaint ${caseNo}; let us continue it here.`;
  if (l === "ne") return `धन्यवाद। तपाईंको उजुरी ${caseNo} भेटियो; यसलाई यहीँ अगाडि बढाऔं।`;
  return `धन्यवाद। आपकी शिकायत ${caseNo} मिल गई; आइए इसे यहीं आगे बढ़ाते हैं।`;
}

export function joinedText(caseNo: string, language: string | null | undefined): string {
  return both((l) => joinedTextIn(caseNo, l), language);
}

export function completeText(caseNo: string, language: string | null | undefined): string {
  return both((l) => completeTextIn(caseNo, l), language);
}

function receivedProofTextIn(l: Lang): string {
  if (l === "en") return "Received, thank you. You can send more screenshots any time.";
  if (l === "ne") return "प्राप्त भयो, धन्यवाद। थप स्क्रिनसट जुनसुकै बेला पठाउन सक्नुहुन्छ।";
  return "मिल गया, धन्यवाद। आप और स्क्रीनशॉट कभी भी भेज सकते हैं।";
}

export function receivedProofText(language: string | null | undefined): string {
  return both((l) => receivedProofTextIn(l), language);
}

function dangerTextIn(l: Lang): string {
  if (l === "en") return "You are not at fault and you must not pay anyone. If anyone's life is in danger right now, call 112. We have marked your complaint urgent for an officer.";
  if (l === "ne") return "तपाईंको गल्ती होइन, कसैलाई पैसा नदिनुहोस्। कसैको ज्यान खतरामा छ भने अहिले नै 112 मा फोन गर्नुहोस्। तपाईंको उजुरी अधिकारीका लागि जरुरी भनेर राखिएको छ।";
  return "इसमें आपकी कोई गलती नहीं है, किसी को भी पैसे न दें। अगर किसी की जान को अभी खतरा है तो तुरंत 112 पर कॉल करें। आपकी शिकायत अधिकारी के लिए अर्जेंट मार्क कर दी गई है।";
}

export function dangerText(language: string | null | undefined): string {
  return both((l) => dangerTextIn(l), language);
}

export function caseNumber(prefix: string, createdAt: Date, seq: number): string {
  return `${prefix}-${createdAt.getUTCFullYear()}-${String(seq).padStart(6, "0")}`;
}

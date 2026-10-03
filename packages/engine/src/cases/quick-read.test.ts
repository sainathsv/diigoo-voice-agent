/** Plain WhatsApp answers read without the AI, and what happens when the AI cannot read a reply. */
import "@jenai/db/env";
import { describe, expect, it } from "vitest";
import { ResilientReader } from "./cases";
import { quickRead } from "./quick-read";

const q = (asking: string | null, text: string, known: Record<string, string> = {}) => quickRead({ asking, text, known });

describe("plain answers, read without the AI", () => {
  it("reads PIN codes, dates and amounts in the usual shapes", () => {
    expect(q("pincode", "249201").result.fields).toEqual({ pincode: "249201" });
    expect(q("pincode", "249 201")).toEqual({ confident: true, result: { fields: { pincode: "249201" } } });
    expect(q("pincode", "२४९२०१").result.fields).toEqual({ pincode: "249201" });
    expect(q("pincode", "24920")).toEqual({ confident: true, result: { fields: {} } }); // asked again with the hint
    expect(q("pincode", "pata nahi").result.fields).toEqual({ pincode: "not known" });
    expect(q("date_of_birth", "15/08/1990").result.fields).toEqual({ date_of_birth: "1990-08-15" });
    expect(q("date_of_birth", "5-1-1988").result.fields).toEqual({ date_of_birth: "1988-01-05" });
    expect(q("date_of_birth", "15 Aug 1990").result.fields).toEqual({ date_of_birth: "1990-08-15" });
    expect(q("date_of_birth", "31/02/1990")).toEqual({ confident: true, result: { fields: {} } });
    expect(q("date_of_birth", "pandrah august").confident).toBe(false);
    expect(q("money_lost", "Rs. 45,000/-").result.fields).toEqual({ money_lost: "45000" });
    expect(q("money_lost", "1.5 lakh").result.fields).toEqual({ money_lost: "150000" });
    expect(q("card_last4", "4321").result.fields).toEqual({ card_last4: "4321" });
    expect(q("card_last4", "4111 1111 1111 4321").result.fields).toEqual({ card_last4: "4321" });
  });

  it("reads names and places typed in English letters, and leaves sentences and Hindi script to the AI", () => {
    expect(q("complainant_name", "sainath tangallapalli").result.fields).toEqual({ complainant_name: "Sainath Tangallapalli" });
    expect(q("complainant_name", "mera naam Ramesh hai").confident).toBe(false);
    expect(q("complainant_name", "रमेश कुमार").confident).toBe(false);
    expect(q("father_or_husband_name", "S/O Sadanandam").result.fields).toEqual({ father_or_husband_name: "F: Sadanandam" });
    expect(q("father_or_husband_name", "w/o Rakesh Rawat").result.fields).toEqual({ father_or_husband_name: "H: Rakesh Rawat" });
    expect(q("father_or_husband_name", "Faisal Khan").result.fields).toEqual({ father_or_husband_name: "Faisal Khan" });
    expect(q("district", "Dehradun").result.fields).toEqual({ district: "Dehradun" });
    expect(q("district", "dehradun district").result.fields).toEqual({ district: "Dehradun" });
    expect(q("police_station", "Rishikesh thana").result.fields).toEqual({ police_station: "Rishikesh" });
    expect(q("house_number", "H.No. 12-4").result.fields).toEqual({ house_number: "12-4" });
    expect(q("present_address", "Shanti Vihar, Rishikesh").result.fields).toEqual({ present_address: "Shanti Vihar, Rishikesh" });
  });

  it("reads the mobile number asked when WhatsApp hides it", () => {
    expect(q("mobile_number", "98000 00071").result.fields).toEqual({ mobile_number: "+919800000071" });
    expect(q("mobile_number", "+91 98000-00071").result.fields).toEqual({ mobile_number: "+919800000071" });
    expect(q("mobile_number", "09800000071").result.fields).toEqual({ mobile_number: "+919800000071" });
    expect(q("mobile_number", "12345")).toEqual({ confident: true, result: { fields: {} } }); // asked again with the hint
  });

  it("takes the bank and the account number together, or in two messages", () => {
    expect(q("victim_bank_and_account", "SBI 3001 2345 678").result.fields).toEqual({ victim_bank_and_account: "SBI; 30012345678" });
    const half = q("victim_bank_and_account", "Hdfc");
    expect(half.result.fields).toEqual({ victim_bank_and_account: "HDFC" });
    expect(q("victim_bank_and_account", "50100123456789", half.result.fields).result.fields).toEqual({ victim_bank_and_account: "HDFC; 50100123456789" });
    expect(q("victim_bank_and_account", "bank of baroda a/c no 12345678901").result.fields).toEqual({ victim_bank_and_account: "Bank of Baroda; 12345678901" });
  });

  it("reads yes or no, the fraudster's numbers and IDs, 'don't know', stop, and a reply that says nothing", () => {
    expect(q("apk_or_link", "nahi").result.fields).toEqual({ apk_or_link: "no" });
    expect(q("apk_or_link", "haan, AnyDesk").result.fields).toEqual({ apk_or_link: "yes: AnyDesk" });
    expect(q("fraudster_details", "Called from +91 98765 43210 on WhatsApp, paid to fraud.king@ybl and mail cheat@gmail.com").result.fields).toEqual({
      suspect_email: "cheat@gmail.com",
      suspect_account_or_upi: "fraud.king@ybl",
      fraudster_mobile: "9876543210",
      fraudster_whatsapp: "9876543210",
    });
    expect(q("fraudster_details", "pata nahi").result.fields).toEqual({ fraudster_details: "not known" });
    expect(q("victim_bank_and_account", "??")).toEqual({ confident: true, result: { fields: {} } });
    expect(q("district", "stop").result.stop).toBe(true);
    expect(q("how_it_happened", "Someone called saying my KYC expired").confident).toBe(false);
    expect(q("pincode", "my OTP is 123456").confident).toBe(false); // the AI drops secrets
    expect(q("district", "he said he will make my photos viral").confident).toBe(false); // the AI judges danger
  });
});

describe("a reply the AI is needed for", () => {
  it("goes to the AI only when it is not a plain answer", async () => {
    let asked = 0;
    const r = new ResilientReader({ read: async () => (asked++, { fields: { how_it_happened: "KYC link fraud" } }) });
    expect((await r.read({ asking: "district", text: "Dehradun", known: {} })).fields).toEqual({ district: "Dehradun" });
    expect(asked).toBe(0);
    expect((await r.read({ asking: "how_it_happened", text: "Kisi ne KYC ke naam pe link bheja", known: {} })).fields).toEqual({ how_it_happened: "KYC link fraud" });
    expect(asked).toBe(1);
  });

  it("is kept as written for the item asked when the AI cannot read it, after waiting its turn", async () => {
    const errors: string[] = [];
    let turns = 0;
    const r = new ResilientReader(
      { read: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434")) },
      { aiTurn: async (read) => (turns++, read()), onAiError: (e) => errors.push(e.message) },
    );
    expect((await r.read({ asking: "how_it_happened", text: "Kisi ne KYC ke naam pe link bheja aur 5000 kat gaye", known: {} })).fields).toEqual({
      how_it_happened: "Kisi ne KYC ke naam pe link bheja aur 5000 kat gaye",
    });
    expect(turns).toBe(1);
    expect(errors[0]).toMatch(/ECONNREFUSED/);
    expect((await r.read({ asking: "pincode", text: "near the temple", known: {} })).fields).toEqual({}); // asked again
    // A server without an AI of its own keeps Hindi as written.
    await expect(new ResilientReader(null).read({ asking: "present_address", text: "गांधी रोड, देहरादून", known: {} })).resolves.toMatchObject({ fields: { present_address: "गांधी रोड, देहरादून" } });
  });
});

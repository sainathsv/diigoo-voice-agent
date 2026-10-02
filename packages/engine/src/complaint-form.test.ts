import { describe, expect, it } from "vitest";
import { maskPhone } from "@jenai/authz";
import { COMPLAINT_FORM, complaintHeader, complaintLines, complaintsCsv, csvCell } from "./complaint-form";

const call = {
  id: "11111111-2222-3333-4444-555555555555",
  startedAt: new Date("2026-09-30T11:07:36Z"),
  durationS: 116,
  phone: "+916395172353",
  summary: "Caller lost 40,000 after a loan link.",
  extracted: {
    complaint_type: "UPI/bank/card fraud",
    complainant_name: "Shivang Agarwal",
    father_or_husband_name: "Kuldeep Agarwal",
    date_of_birth: "1998-05-26",
    house_number: "403",
    present_address: "Paramax Apartment, Rishikesh",
    police_station: "Rishikesh",
    district: "Dehradun",
    pincode: "249201",
    victim_bank_and_account: "HDFC; 50100012342414",
    card_last4: "4111 1111 1111 2414",
    money_lost: "40000",
    transactions: "40000 | 30 Sep 10:20 | UTR 412345678901",
    how_it_happened: "Clicked a loan app link",
    fraudster_mobile: "9000000001",
    fraudster_whatsapp: "null",
    suspect_account_or_upi: "fraud@upi",
    apk_or_link: "yes: loanfast.apk",
    danger: "no",
  },
};

describe("complaint case sheet", () => {
  it("fills every line of the department's form, in its order", () => {
    const lines = complaintLines(call);
    expect(lines.map((l) => l.hi)).toEqual(COMPLAINT_FORM.map((f) => f.hi));
    const v = Object.fromEntries(lines.map((l) => [l.en, l.value]));
    expect(v["Mobile number"]).toBe("+916395172353");
    expect(v["Father's / husband's name"]).toBe("Kuldeep Agarwal");
    expect(v["PIN code"]).toBe("249201");
    expect(v["Fraudster's WhatsApp"]).toBe(""); // "null" from the model is not a value
    expect(v["APK file or link (yes / no)"]).toBe("हाँ / Yes (loanfast.apk)");
  });
  it("never shows more than the last 4 digits of a card", () => {
    const card = complaintLines(call).find((l) => l.en.startsWith("Card"))!.value;
    expect(card).toBe("XXXX XXXX XXXX 2414");
    expect(card).not.toContain("4111");
  });
  it("masks the complainant's number when the viewer may not see it", () => {
    const v = complaintLines(call, { mask: maskPhone })[0]!.value;
    expect(v).not.toContain("6395172353");
    expect(v).toContain("2353");
  });
  it("uses the caller ID, never a number the caller gave for the fraudster", () => {
    // The analyser once put the fraudster's number in the complainant's own line.
    const mixedUp = { ...call, extracted: { ...call.extracted, complainant_mobile: "9000000001" } };
    expect(complaintLines(mixedUp)[0]!.value).toBe("+916395172353");
    const other = { ...call, extracted: { ...call.extracted, complainant_mobile: "9811122233" } };
    expect(complaintLines(other)[0]!.value).toBe("+916395172353 (also gave 9811122233)");
    expect(complaintLines(other, { mask: maskPhone })[0]!.value).not.toMatch(/6395172353|9811122233/);
  });
  it("names the scam type from the catalogue", () => {
    expect(complaintHeader(call).scam).toBe("UPI, bank or card fraud");
  });
  it("exports a spreadsheet Excel reads in Hindi, one row per call", () => {
    const csv = complaintsCsv([call, call], () => "30 Sep 2026");
    expect(csv.startsWith("﻿")).toBe(true);
    const rows = csv.trim().split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("पिता/पति का नाम / Father's / husband's name");
    expect(rows[1]).toContain("HDFC; 50100012342414"); // no comma, so unquoted
    expect(rows[1]).toContain("Shivang Agarwal");
  });
  it("keeps numbers exact and never lets a cell run as a formula in Excel", () => {
    const q = (v: string) => `"=""${v.replace(/"/g, '""""')}"""`; // how ="v" looks inside a quoted CSV cell
    expect(csvCell("+916395172353")).toBe(q("+916395172353")); // not 9.16E+11
    expect(csvCell("50100012342414123")).toBe(q("50100012342414123")); // no digits lost past 15
    expect(csvCell("@fraud_handle")).toBe(q("@fraud_handle"));
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(q('=HYPERLINK("http://x","click")'));
    expect(csvCell("-" + "x".repeat(300)).startsWith("'-")).toBe(true);
    expect(csvCell("Rishikesh, Dehradun")).toBe('"Rishikesh, Dehradun"');
    expect(csvCell("plain")).toBe("plain");
  });
});

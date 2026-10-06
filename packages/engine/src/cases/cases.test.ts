/**
 * Cases end to end against real Postgres (row-level security on), with a
 * simulated WhatsApp and a scripted reader standing in for the model.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, calls, caseCalls, caseEvidence, caseMessages, cases, organizations, platformDb, whatsappChannels, whatsappInbox, withTenant } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";
import { scamKeyFromText } from "../scams";
import { ResilientReader, caseFromCall, complainantNumber, fieldsFromCall, followUpCalls, handleInbound, parseRead, remindPending, resendFailed, type CaseReader, type ReadResult } from "./cases";
import { missingFor, questionFor, reminderText, withPinLocation } from "./catalog";
import { INBOX_MAX_ATTEMPTS, processInbox, queueInbound, retryInbox } from "./inbox";
import { SimulatedWhatsApp, chatIdFor, parseOpenWaWebhook, validSignature, type QueuedMessage, type WhatsAppSender } from "./whatsapp";
import { createHmac } from "node:crypto";

let tenant = "";
const phone = "+919812345678";

/** Answers whatever was asked, the way a person would reply. */
class ScriptedReader implements CaseReader {
  constructor(private readonly answers: Record<string, Partial<ReadResult>>) {}
  async read(input: { asking: string | null; text: string }): Promise<ReadResult> {
    return { fields: {}, language: "hi", ...(this.answers[input.text] ?? {}) } as ReadResult;
  }
}

beforeAll(async () => {
  const [org] = await platformDb()
    .insert(organizations)
    .values({ kind: "client", name: "CY Police", slug: `cy-test-${randomUUID().slice(0, 6)}`, status: "active", vertical: "government", languages: ["hi", "en", "ne"] })
    .returning();
  tenant = org!.id;
  await withTenant(tenant, (tx) => tx.insert(whatsappChannels).values({ tenantId: tenant, mode: "simulated" }));
});
afterAll(async () => {
  await platformDb().delete(organizations).where(eq(organizations.id, tenant));
});

describe("case catalogue", () => {
  it("maps what the call analyser said onto scam types", () => {
    expect(scamKeyFromText("UPI/bank/card fraud")).toBe("upi_bank_card");
    expect(scamKeyFromText("digital arrest")).toBe("digital_arrest");
    expect(scamKeyFromText("bank account frozen by cyber cell")).toBe("account_frozen");
    expect(scamKeyFromText("something new")).toBe("other");
  });
  it("asks the whole form only when money was lost; other complaints get the form link", () => {
    expect(missingFor({}, "account_frozen", 0)).toEqual([]);
    expect(missingFor({}, "online_harassment", 0)).toEqual([]);
    const money = missingFor({}, "upi_bank_card", 0);
    // The police station and district come after the PIN code: found from it and confirmed, or asked when it is not listed.
    expect(money).toEqual(["complainant_name", "father_or_husband_name", "date_of_birth", "house_number", "present_address", "pincode", "victim_bank_and_account", "transactions", "money_lost", "how_it_happened", "fraudster_details", "apk_or_link", "proof"]);
    expect(missingFor(withPinLocation({ pincode: "249201" }), "upi_bank_card", 0)).toContain("location_check");
    expect(missingFor(withPinLocation({ pincode: "110001" }), "upi_bank_card", 0)).toEqual(expect.arrayContaining(["police_station", "district"]));
    // A money fraud reported 3 or more days late goes to the form link: nothing is asked.
    expect(missingFor({ followup: "form_link", financial: "yes" }, "upi_bank_card", 0)).toEqual([]);
    expect(missingFor({ money_lost: "5000" }, "other", 0)).toContain("transactions");
    expect(missingFor({ financial: "yes" }, "other", 0)).toContain("transactions");
    expect(missingFor({}, "upi_bank_card", 1)).not.toContain("proof");
    expect(missingFor({}, null, 0)).toEqual(["how_it_happened", "scam_type"]);
  });
  it("asks for the card only when a card was used", () => {
    expect(missingFor({ complaint_type: "UPI/bank/card fraud" }, "upi_bank_card", 0)).not.toContain("card_last4");
    expect(missingFor({ how_it_happened: "Someone used my debit card online" }, "upi_bank_card", 0)).toContain("card_last4");
  });
  it("counts an answer only in the right shape, or 'not known' where that is honest", () => {
    const has = (f: Record<string, string>, k: string) => !missingFor(f, "upi_bank_card", 1).includes(k);
    expect(has({ pincode: "24920" }, "pincode")).toBe(false);
    expect(has({ pincode: "249 201" }, "pincode")).toBe(true);
    expect(has({ pincode: "not known" }, "pincode")).toBe(true);
    expect(has({ complainant_name: "not known" }, "complainant_name")).toBe(false);
    expect(has({ date_of_birth: "1990-08-15" }, "date_of_birth")).toBe(true);
    expect(has({ date_of_birth: "15 August" }, "date_of_birth")).toBe(false);
    expect(has({ transactions: "40000 | 28 Sep | 412345678901" }, "transactions")).toBe(true);
    expect(has({ transactions: "paid twice" }, "transactions")).toBe(false);
    expect(has({ victim_bank_and_account: "SBI" }, "victim_bank_and_account")).toBe(false);
    expect(has({ suspect_account_or_upi: "fraud@ybl" }, "fraudster_details")).toBe(true);
    expect(has({ fraudster_details: "not known" }, "fraudster_details")).toBe(true);
  });
  it("writes every WhatsApp message in Hindi and English together (Nepali and English for a Nepali speaker)", () => {
    const hi = questionFor("pincode", "hi");
    expect(hi).toContain("आपके क्षेत्र का पिनकोड");
    expect(hi).toContain("What is your PIN code");
    expect(questionFor("pincode", "en")).toContain("आपके क्षेत्र का पिनकोड"); // English writers still get both
    const ne = questionFor("pincode", "ne");
    expect(ne).toContain("तपाईंको क्षेत्रको पिनकोड");
    expect(ne).toContain("What is your PIN code");
    expect(ne).not.toContain("आपके क्षेत्र का पिनकोड");
    const r = reminderText("CY-2026-000001", ["pincode", "proof"], "hi");
    expect(r).toContain("पिनकोड, सबूत (स्क्रीनशॉट)");
    expect(r).toContain("PIN code, proof (screenshots)");
  });
  it("never keeps more than the last 4 digits of a card", () => {
    expect(fieldsFromCall({ card_last4: "4111 1111 1111 1234" }).card_last4).toBe("1234");
    expect(parseRead('{"fields":{"card_last4":"4111111111111234"}}').fields).toEqual({ card_last4: "1234" });
  });
  it("drops secrets the model tries to echo into a case", () => {
    const r = parseRead('{"fields":{"complainant_name":"Sainath","transactions":"my OTP is 448219","nonsense_key":"x"}}');
    expect(r.fields).toEqual({ complainant_name: "Sainath" });
  });
});

describe("a money fraud from call to officers", () => {
  const wa = new SimulatedWhatsApp();
  const call = (extracted: Record<string, unknown>, who = phone) => withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted }, wa));

  it("opens a case after the call and asks on WhatsApp only what the call did not take", async () => {
    const c = await call({ complaint_type: "UPI/bank/card fraud", how_it_happened: "Clicked a loan link, 40000 went by UPI", money_lost: "40000", complainant_name: "Sainath", call_language: "hindi", whatsapp_consent: "yes" });
    expect(c!.status).toBe("collecting");
    expect(c!.scamType).toBe("upi_bank_card");
    expect(c!.fields.followup).toBe("questions");
    expect(c!.fields.complainant_name).toBe("Sainath"); // confirmed on the call, not asked again
    expect(c!.missing[0]).toBe("father_or_husband_name");
    expect(c!.missing).not.toContain("complainant_name");
    expect(c!.missing).not.toContain("how_it_happened");
    expect(c!.missing).toHaveLength(10);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.body).toMatch(/शिकायत संख्या CY-\d{4}-000001/);
    expect(wa.sent[0]!.body).toContain("पिता या पति");
    expect(wa.sent[0]!.body).toContain("father's or husband's name");
    expect(wa.sent[0]!.body).toContain("Your complaint number is CY-");
  });

  it("a second call about the case in progress adds to it, and WhatsApp picks up where it left off", async () => {
    await call({ complaint_type: "UPI fraud", fraudster_mobile: "9000000001", whatsapp_consent: "yes" });
    const all = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, phone)));
    expect(all).toHaveLength(1);
    expect(all[0]!.fields.fraudster_mobile).toBe("9000000001");
    expect(wa.sent).toHaveLength(2);
    expect(wa.sent[1]!.body).toMatch(/शिकायत CY-\d{4}-000001 के बारे में आपकी कॉल मिल गई/);
    expect(wa.sent[1]!.body).toContain("We have received your call about complaint CY-");
    expect(wa.sent[1]!.body).toContain("father's or husband's name"); // the question still waiting for an answer
  });

  it("takes the form one line at a time, re-asks an answer in the wrong shape, stores proof, and hands the case over", async () => {
    const reader = new ScriptedReader({
      "Sainath Tangallapalli": { fields: { complainant_name: "Sainath Tangallapalli" } },
      "Sadanandam": { fields: { father_or_husband_name: "F: Sadanandam" } },
      "15/08/1990": { fields: { date_of_birth: "1990-08-15" } },
      "12-4": { fields: { house_number: "12-4" } },
      "Shanti Vihar, Rishikesh": { fields: { present_address: "Shanti Vihar, Rishikesh" } },
      "24920": { fields: { pincode: "24920" } },
      "249201": { fields: { pincode: "249201" } },
      "haan sahi hai": { fields: { location_confirmed: "yes" } },
      "SBI 30012345678": { fields: { victim_bank_and_account: "SBI; 30012345678" } },
      "UTR 412345678901, 40000, 28 Sep": { fields: { transactions: "40000 | 28 Sep | 412345678901" } },
      "40000": { fields: { money_lost: "40000" } },
      "Clicked a loan link and paid by UPI": { fields: { how_it_happened: "Clicked a loan link and paid by UPI" } },
      "no": { fields: { apk_or_link: "no" } },
    });
    const say = (text: string) => handleInbound(tenant, { from: phone, id: randomUUID(), at: new Date(), text }, reader, wa);
    await say("Sadanandam");
    expect(wa.sent.at(-1)!.body).toContain("जन्म तिथि");
    for (const t of ["15/08/1990", "12-4", "Shanti Vihar, Rishikesh"]) await say(t);
    expect(wa.sent.at(-1)!.body).toContain("6. आपके क्षेत्र का पिनकोड");
    await say("24920"); // five digits
    expect(wa.sent.at(-1)!.body).toContain("6 अंकों");
    expect(wa.sent.at(-1)!.body).toContain("6. आपके क्षेत्र का पिनकोड");
    // The PIN code gives the district and the likely police station: only confirmed, not asked.
    await say("249201");
    expect(wa.sent.at(-1)!.body).toContain("By your PIN code 249201, your district is Dehradun and your police station is likely Rishikesh. Is that right?");
    await say("haan sahi hai");
    expect(wa.sent.at(-1)!.body).toContain("8. Which bank");
    for (const t of ["SBI 30012345678", "UTR 412345678901, 40000, 28 Sep"]) await say(t);
    // The amount and what happened came from the call, the fraudster's number from the second call: next is the APK question.
    expect(wa.sent.at(-1)!.body).toContain("APK");
    await say("no");
    expect(wa.sent.at(-1)!.body).toContain("सबूत");

    wa.media.set("media-1", { bytes: Buffer.from("fake-png"), mime: "image/png" });
    const r = await handleInbound(tenant, { from: phone, id: randomUUID(), at: new Date(), media: { id: "media-1", kind: "image", mime: "image/png" } }, reader, wa);
    expect(r!.ready).toBe(true);
    expect(wa.sent.at(-1)!.body).toContain("मिल गया");
    expect(wa.sent.at(-1)!.body).toContain("अधिकारियों को सौंप दी गई");

    const [c] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, phone)));
    expect(c!.status).toBe("ready");
    expect(c!.missing).toEqual([]);
    expect(c!.district).toBe("Dehradun");
    expect(c!.fields.police_station).toBe("Rishikesh");
    expect(c!.fields.location_confirmed).toBe("yes");
    expect(c!.amountLostPaise).toBe(4_000_000);
    const ev = await withTenant(tenant, (tx) => tx.select().from(caseEvidence));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores a WhatsApp message it has already handled", async () => {
    const before = await withTenant(tenant, (tx) => tx.select().from(caseMessages));
    const id = before.find((m) => m.direction === "in")!.externalId!;
    expect(await handleInbound(tenant, { from: phone, id, at: new Date(), text: "Sainath" }, new ScriptedReader({}), wa)).toBeNull();
  });
});

describe("without a yes, or without money lost", () => {
  it("writes to the WhatsApp number the caller gave when it differs from the calling number", async () => {
    const wa = new SimulatedWhatsApp();
    const c = await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: "+919800000021", contactId: null, branchId: null, extracted: { complaint_type: "UPI fraud", money_lost: "2000", complainant_name: "Hema", how_it_happened: "UPI collect request approved by mistake", whatsapp_consent: "yes", whatsapp_number: "98000 00022" } }, wa));
    expect(c!.complainantE164).toBe("+919800000022");
    expect(c!.fields.caller_number).toBe("+919800000021");
    expect(wa.sent[0]!.to).toBe("+919800000022");
  });

  it("sends nothing when the caller did not agree, and gives officers what the call took", async () => {
    const wa = new SimulatedWhatsApp();
    const who = "+919800000011";
    const c = await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted: { complaint_type: "investment/trading/crypto", money_lost: "250000", complainant_name: "Meena Rawat", whatsapp_consent: "no" } }, wa));
    expect(wa.sent).toHaveLength(0);
    expect(c!.status).toBe("ready");
    expect(c!.fields.followup).toBe("none");
    expect(c!.fields.complainant_name).toBe("Meena Rawat");
    expect(c!.missing.length).toBeGreaterThan(0); // shown to officers as still needed

    // Writing to the helpline later counts as a yes.
    const r = await handleInbound(tenant, { from: who, id: randomUUID(), at: new Date(), text: "hello" }, new ScriptedReader({}), wa);
    expect(r).not.toBeNull();
    expect(wa.sent.at(-1)!.body).toContain("पिता या पति");
  });

  it("sends the cyber team's form link once for a complaint without money lost", async () => {
    await withTenant(tenant, (tx) => tx.update(whatsappChannels).set({ formUrl: "https://forms.example.gov.in/cy-complaint" }));
    const wa = new SimulatedWhatsApp();
    const who = "+919800000012";
    const c = await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted: { complaint_type: "online harassment, stalking or threats", how_it_happened: "Someone keeps sending threats on Instagram", whatsapp_consent: "yes", call_language: "english" } }, wa));
    expect(c!.status).toBe("ready");
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.body).toContain("https://forms.example.gov.in/cy-complaint");
    expect(wa.sent[0]!.body).toMatch(/complaint number is CY-\d{4}-\d{6}/);
    // A screenshot they send later is kept as proof, and nothing more is sent.
    wa.media.set("m-x", { bytes: Buffer.from("shot"), mime: "image/jpeg" });
    await handleInbound(tenant, { from: who, id: randomUUID(), at: new Date(), media: { id: "m-x", kind: "image" } }, new ScriptedReader({}), wa);
    expect(wa.sent).toHaveLength(1);
  });

  it("says so in the case when the form link is not set up yet", async () => {
    await withTenant(tenant, (tx) => tx.update(whatsappChannels).set({ formUrl: null }));
    const wa = new SimulatedWhatsApp();
    const c = await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: "+919800000013", contactId: null, branchId: null, extracted: { complaint_type: "hacked account or fake profile", how_it_happened: "Fake profile with my photos", whatsapp_consent: "yes" } }, wa));
    expect(wa.sent).toHaveLength(0);
    const msgs = await withTenant(tenant, (tx) => tx.select().from(caseMessages).where(eq(caseMessages.caseId, c!.id)));
    expect(msgs[0]!.status).toBe("failed");
    expect(msgs[0]!.error).toMatch(/form link/);
  });
});

describe("each call is followed once", () => {
  const at = (who: string, extracted: Record<string, unknown>, wa: SimulatedWhatsApp, opts?: { message?: boolean }, id: string = randomUUID()) =>
    withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id, phone: who, contactId: null, branchId: null, extracted }, wa, opts));

  it("reads a call twice (the engine's details at once, the local AI later) and messages only once", async () => {
    const wa = new SimulatedWhatsApp();
    const id = randomUUID();
    const first = await at("+919800000031", { complaint_type: "UPI/bank/card fraud", money_lost: "15000", complainant_name: "Asha Negi", whatsapp_consent: "yes" }, wa, undefined, id);
    expect(wa.sent).toHaveLength(1);
    const again = await at("+919800000031", { complaint_type: "UPI/bank/card fraud", complainant_name: "Asha N", district: "Dehradun", danger: "yes" }, wa, undefined, id);
    expect(again!.id).toBe(first!.id);
    expect(wa.sent).toHaveLength(1);
    expect(again!.fields.complainant_name).toBe("Asha Negi"); // what the case holds stays
    expect(again!.fields.district).toBe("Dehradun"); // what is new fills the gap
    expect(again!.fields.urgent).toBe("yes");
    expect(again!.missing).not.toContain("district");
  });

  it("follows a call on WhatsApp unless the caller said they have no WhatsApp", async () => {
    const wa = new SimulatedWhatsApp();
    const c = await at("+919800000032", { complaint_type: "digital arrest", money_lost: "90000", how_it_happened: "Fake CBI officer on a video call" }, wa);
    expect(c!.fields.followup).toBe("questions");
    expect(wa.sent).toHaveLength(1);
    const none = await at("+919800000035", { complaint_type: "digital arrest", money_lost: "90000", whatsapp_consent: "no" }, wa);
    expect(none!.fields.followup).toBe("none");
    expect(wa.sent).toHaveLength(1);
  });

  it("opens a new case for a different kind of complaint, or when the earlier one is with officers", async () => {
    await withTenant(tenant, (tx) => tx.update(whatsappChannels).set({ formUrl: "https://forms.example.gov.in/cy-complaint" }));
    const wa = new SimulatedWhatsApp();
    const who = "+919800000033";
    const money = await at(who, { complaint_type: "UPI fraud", money_lost: "3000", how_it_happened: "Paid a fake seller" }, wa);
    const threats = await at(who, { complaint_type: "online harassment", how_it_happened: "Threats on Instagram" }, wa);
    expect(threats!.id).not.toBe(money!.id);
    expect(wa.sent).toHaveLength(2);
    expect(wa.sent[1]!.body).toContain("https://forms.example.gov.in/cy-complaint");
    // A reply goes to the case still being filled in.
    await handleInbound(tenant, { from: who, id: randomUUID(), at: new Date(), text: "F: Mohan" }, new ScriptedReader({ "F: Mohan": { fields: { father_or_husband_name: "F: Mohan" } } }), wa);
    const [m] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.id, money!.id)));
    expect(m!.fields.father_or_husband_name).toBe("F: Mohan");
    // Once that case is with officers, a new call is a new complaint.
    await withTenant(tenant, (tx) => tx.update(cases).set({ status: "taken_up" }).where(eq(cases.id, money!.id)));
    const later = await at(who, { complaint_type: "UPI fraud", money_lost: "800", how_it_happened: "Another fake seller" }, wa);
    expect(later!.id).not.toBe(money!.id);
    expect(wa.sent.at(-1)!.body).toContain("Your complaint number is CY-");
    await withTenant(tenant, (tx) => tx.update(whatsappChannels).set({ formUrl: null }));
  });

  it("answers plain replies at once without the AI: half a bank answer gets the hint, the other half completes it", async () => {
    const wa = new SimulatedWhatsApp();
    const who = "+919800000051";
    await at(who, { complaint_type: "UPI fraud", money_lost: "5000", complainant_name: "Kavita Joshi", father_or_husband_name: "F: Mohan Joshi", date_of_birth: "1990-01-01", house_number: "12", present_address: "Rajpur Road, Dehradun", police_station: "Rajpur", district: "Dehradun", pincode: "248001" }, wa);
    expect(wa.sent.at(-1)!.body).toContain("8. Which bank"); // their own police station and district: nothing to confirm
    const say = (text: string) => handleInbound(tenant, { from: who, id: randomUUID(), at: new Date(), text }, new ResilientReader(null), wa);
    await say("Hdfc");
    expect(wa.sent.at(-1)!.body).toContain("both the bank name and the account number");
    expect(wa.sent.at(-1)!.body).toContain("8. Which bank");
    await say("50100123456789");
    const [c] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, who)));
    expect(c!.fields.victim_bank_and_account).toBe("HDFC; 50100123456789");
    expect(wa.sent.at(-1)!.body).toContain("10. Send the UTR");
    expect(c!.fields.police_station).toBe("Rajpur");
  });

  it("does not message about a call read long after it happened", async () => {
    const wa = new SimulatedWhatsApp();
    const c = await at("+919800000034", { complaint_type: "loan app harassment", how_it_happened: "Loan app threats" }, wa, { message: false });
    expect(c).not.toBeNull();
    expect(wa.sent).toHaveLength(0);
  });

  it("starts WhatsApp right after the call from what the engine took, once per call", async () => {
    const wa = new SimulatedWhatsApp();
    const who = "+919800000041";
    const [agent] = await withTenant(tenant, (tx) => tx.insert(agents).values({ tenantId: tenant, name: "CY line", templateKey: "clinic_receptionist", templateVersion: 2, domain: CYBER_INTAKE_DOMAIN }).returning());
    const row = (extracted: Record<string, unknown>, startedAt = new Date(), status: "completed" | "in_progress" = "completed") => ({
      tenantId: tenant, agentId: agent!.id, direction: "inbound" as const, status, externalRunId: randomUUID(), fromE164: who, toE164: "+919262102414", startedAt, extracted,
    });
    const [fresh] = await withTenant(tenant, (tx) =>
      tx
        .insert(calls)
        .values([
          row({ complaint_type: "UPI/bank/card fraud", money_lost: "12000", complainant_name: "Ravi Bisht", whatsapp_consent: "yes", call_language: "hindi" }),
          row({}), // the engine has not read it yet
          row({ complaint_type: "UPI fraud" }, new Date(), "in_progress"), // still on the line
          row({ complaint_type: "UPI fraud", money_lost: "500" }, new Date(Date.now() - 5 * 3_600_000)), // hours ago: not messaged now
          row({ complaint_type: "not cyber crime", how_it_happened: "Bicycle stolen" }),
        ])
        .returning(),
    );
    expect(await followUpCalls(tenant, { sender: wa })).toBe(1);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe(who);
    expect(wa.sent[0]!.body).toContain("Your complaint number is CY-");
    expect(await followUpCalls(tenant, { sender: wa })).toBe(0);
    // The local AI reads the same call later: it fills in and does not message again.
    const k = await at(who, { complaint_type: "UPI/bank/card fraud", money_lost: "12000", district: "Almora" }, wa, undefined, fresh!.id);
    expect(wa.sent).toHaveLength(1);
    expect(k!.fields.district).toBe("Almora");
    expect(await withTenant(tenant, (tx) => tx.select().from(caseCalls).where(eq(caseCalls.callId, fresh!.id)))).toHaveLength(1);
  });
});

describe("the department's rules", () => {
  const opened = (who: string, extracted: Record<string, unknown>, wa: SimulatedWhatsApp, at = new Date("2026-10-06T06:00:00Z")) =>
    withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted, at }, wa));

  it("sends a money fraud reported 3 or more days after the transaction to the form link, and asks nothing", async () => {
    await withTenant(tenant, (tx) => tx.update(whatsappChannels).set({ formUrl: "https://cybercrime.gov.in/" }));
    const wa = new SimulatedWhatsApp();
    const said = await opened("+919800000091", { complaint_type: "UPI fraud", money_lost: "12000", how_it_happened: "Paid a fake seller", within_3_days: "no" }, wa);
    expect(said!.fields).toMatchObject({ followup: "form_link", late_report: "yes", financial: "yes" });
    expect(said!.status).toBe("ready");
    expect(said!.missing).toEqual([]);
    expect(wa.sent[0]!.body).toContain("This helpline takes money fraud complaints only within 3 days of the transaction. Please file your complaint at this link: https://cybercrime.gov.in/");
    expect(wa.sent[0]!.body).toContain("ट्रांजेक्शन के 3 दिन के अंदर ही ली जाती है");
    // Worked out from the date the money left, against the day of the call (6 October).
    const dated = await opened("+919800000092", { complaint_type: "UPI fraud", money_lost: "900", how_it_happened: "Paid a fake seller", transaction_date: "2026-10-03" }, wa);
    expect(dated!.fields.late_report).toBe("yes");
    const recent = await opened("+919800000093", { complaint_type: "UPI fraud", money_lost: "900", how_it_happened: "Paid a fake seller", transaction_date: "2026-10-04" }, wa);
    expect(recent!.fields.followup).toBe("questions");
    expect(wa.sent.at(-1)!.body).toContain("1. What is your full name?");
    await withTenant(tenant, (tx) => tx.update(whatsappChannels).set({ formUrl: null }));
  });

  it("asks the police station and district for a PIN code outside Uttarakhand, and takes a correction of the ones it found", async () => {
    const wa = new SimulatedWhatsApp();
    const ask = (who: string) => (text: string, reader: CaseReader = new ResilientReader(null)) => handleInbound(tenant, { from: who, id: randomUUID(), at: new Date(), text }, reader, wa);
    const base = { complaint_type: "UPI fraud", money_lost: "900", how_it_happened: "Paid a fake seller", complainant_name: "Asha Rawat", father_or_husband_name: "F: Ram Rawat", date_of_birth: "1990-01-01", house_number: "7", present_address: "Karol Bagh, New Delhi" };
    await opened("+919800000094", base, wa);
    const delhi = ask("+919800000094");
    await delhi("110005");
    expect(wa.sent.at(-1)!.body).toContain("Which is your police station?");
    // A PIN code in the list, then the right police station instead of "yes".
    await opened("+919800000095", { ...base, present_address: "Mayapur, Haridwar" }, wa);
    const hw = ask("+919800000095");
    await hw("249401");
    expect(wa.sent.at(-1)!.body).toContain("your district is Haridwar and your police station is likely Haridwar");
    await hw("Kotwali Nagar");
    const [c] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, "+919800000095")));
    expect(c!.fields).toMatchObject({ police_station: "Kotwali Nagar", district: "Haridwar", location_confirmed: "corrected" });
    expect(wa.sent.at(-1)!.body).toContain("8. Which bank");
  });
});

describe("replies WhatsApp refused", () => {
  const refusing = (why: string): WhatsAppSender => ({
    mode: "openwa",
    sendText: async () => Promise.reject(new Error(why)),
    fetchMedia: async () => Promise.reject(new Error("no media")),
  });
  const opened = (who: string, sender: WhatsAppSender) =>
    withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted: { complaint_type: "UPI fraud", money_lost: "900", how_it_happened: "Paid a fake seller" } }, sender));

  it("are sent again when the gateway takes them, once, and only when the refusal can pass", async () => {
    const paced = await opened("+919800000081", refusing("OpenWA refused POST /sessions/:session/messages/send-text (429): Daily send allowance of 40 reached for a session 1 day(s) old"));
    await opened("+919800000082", refusing("OpenWA refused POST /sessions/:session/messages/send-text (400): chatId must be a WhatsApp id"));
    const [m] = await withTenant(tenant, (tx) => tx.select().from(caseMessages).where(eq(caseMessages.caseId, paced!.id)));
    expect(m!.status).toBe("failed");
    // Still refused: kept for the next round, with the newest reason.
    expect(await resendFailed(tenant, refusing("OpenWA refused POST /sessions/:session/messages/send-text (409): Session is not connected"))).toBe(0);
    const wa = new SimulatedWhatsApp();
    expect(await resendFailed(tenant, wa)).toBe(1); // the 400 is not tried again
    expect(wa.sent).toEqual([{ to: "+919800000081", body: m!.body }]);
    const [again] = await withTenant(tenant, (tx) => tx.select().from(caseMessages).where(eq(caseMessages.id, m!.id)));
    expect(again!.status).toBe("simulated");
    expect(again!.error).toBeNull();
    expect(await resendFailed(tenant, wa)).toBe(0);
  });
});

describe("reminders", () => {
  it("reminds someone who went quiet, within calling hours, at most six times, and never someone who said no", async () => {
    const wa = new SimulatedWhatsApp();
    const who = "+919800000002";
    await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted: { complaint_type: "part-time job/task scam", how_it_happened: "Paid for tasks", whatsapp_consent: "yes" } }, wa));
    const noonIst = new Date("2026-09-30T06:30:00Z"); // 12:00 IST
    const later = (h: number) => new Date(noonIst.getTime() + h * 3_600_000);
    await withTenant(tenant, (tx) => tx.update(cases).set({ lastOutboundAt: new Date("2026-09-29T00:00:00Z") }).where(eq(cases.complainantE164, who)));
    expect(await remindPending(tenant, noonIst, undefined, wa)).toBe(1);
    expect(wa.sent.at(-1)!.body).toContain("याद दिला");
    expect(await remindPending(tenant, later(1), undefined, wa)).toBe(0); // too soon
    expect(await remindPending(tenant, new Date("2026-09-30T17:00:00Z"), undefined, wa)).toBe(0); // 22:30 IST, too late
    expect(await remindPending(tenant, later(7), undefined, wa)).toBe(1);
    await withTenant(tenant, (tx) => tx.update(cases).set({ remindersSent: 6 }).where(eq(cases.complainantE164, who)));
    expect(await remindPending(tenant, later(20), undefined, wa)).toBe(0);
    // The caller who said no on the call (above) is never reminded.
    const quiet = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, "+919800000011")));
    expect(quiet[0]!.remindersSent).toBe(0);
  });
});

describe("WhatsApp through OpenWA", () => {
  const hook = (event: string, data: Record<string, unknown>) => ({ event, timestamp: "2026-10-02T10:00:00.000Z", sessionId: "cy-session", idempotencyKey: "k", deliveryId: "d", data });

  it("accepts only deliveries signed with the webhook secret", () => {
    const body = JSON.stringify(hook("message.received", {}));
    const sig = `sha256=${createHmac("sha256", "s3cret-s3cret-16").update(body).digest("hex")}`;
    expect(validSignature(body, sig, "s3cret-s3cret-16")).toBe(true);
    expect(validSignature(body, sig, "another-secret-16")).toBe(false);
    expect(validSignature(body, null, "s3cret-s3cret-16")).toBe(false);
    expect(validSignature(body, sig.slice(0, -2), "s3cret-s3cret-16")).toBe(false);
  });

  it("reads a citizen's text, photo and privacy-id messages, and ignores groups, statuses and our own", () => {
    const text = parseOpenWaWebhook(hook("message.received", { id: "m1", from: "919812345678@c.us", chatId: "919812345678@c.us", body: "mera naam Sainath", type: "text", timestamp: 1790000000, kind: "individual", fromMe: false, isGroup: false }));
    expect(text).toMatchObject({ kind: "message", sessionId: "cy-session", message: { id: "m1", from: "+919812345678", lid: null, text: "mera naam Sainath" } });
    const photo = parseOpenWaWebhook(hook("message.received", { id: "m2", from: "919812345678@c.us", chatId: "919812345678@c.us", body: "UTR slip", type: "image", timestamp: 1790000001, media: { mimetype: "image/jpeg", data: "aGVsbG8=" } }));
    expect(photo).toMatchObject({ kind: "message", message: { text: "UTR slip", media: { kind: "image", mime: "image/jpeg", dataBase64: "aGVsbG8=" } } });
    const voice = parseOpenWaWebhook(hook("message.received", { id: "m3", from: "919812345678@c.us", chatId: "919812345678@c.us", type: "voice", media: { mimetype: "audio/ogg", omitted: true } }));
    expect(voice).toMatchObject({ kind: "message", message: { media: { kind: "audio", mime: "audio/ogg" } } });
    expect((voice as { message: QueuedMessage }).message.media!.dataBase64).toBeUndefined();
    const lid = parseOpenWaWebhook(hook("message.received", { id: "m4", from: "12345678901234@lid", chatId: "12345678901234@lid", body: "hello", type: "text", isLidSender: true }));
    expect(lid).toMatchObject({ kind: "message", message: { from: null, lid: "12345678901234@lid" } });
    const lidKnown = parseOpenWaWebhook(hook("message.received", { id: "m5", from: "12345678901234@lid", chatId: "12345678901234@lid", body: "hello", type: "text", senderPhone: "919800000009" }));
    expect(lidKnown).toMatchObject({ message: { from: "+919800000009" } });
    for (const d of [
      { id: "g", from: "1203@g.us", chatId: "1203@g.us", body: "hi", isGroup: true },
      { id: "s", from: "status@broadcast", chatId: "status@broadcast", body: "hi", isStatusBroadcast: true },
      { id: "o", from: "919812345678@c.us", chatId: "919812345678@c.us", body: "hi", fromMe: true },
      { id: "st", from: "919812345678@c.us", chatId: "919812345678@c.us", type: "sticker" },
    ])
      expect(parseOpenWaWebhook(hook("message.received", d))!.kind).toBe("ignored");
  });

  it("reads delivery receipts and the link status", () => {
    expect(parseOpenWaWebhook(hook("message.ack", { id: "x", messageId: "out-1", status: "read", ack: 3 }))).toEqual({ kind: "ack", sessionId: "cy-session", id: "out-1", status: "read" });
    expect(parseOpenWaWebhook(hook("session.authenticated", { sessionId: "cy-session", phone: "919000011111", pushName: "CY Police" }))).toEqual({ kind: "link", sessionId: "cy-session", status: "ready", phone: "+919000011111" });
    expect(parseOpenWaWebhook(hook("session.status", { sessionId: "cy-session", status: "qr_ready" }))).toMatchObject({ kind: "link", status: "qr_ready" });
    expect(parseOpenWaWebhook({ hello: "world" })).toBeNull();
  });

  it("queues each message once, and answers someone who has not called with the department's greeting only", async () => {
    const wa = new SimulatedWhatsApp();
    const who = "+919800000003";
    let read = 0;
    const reader: CaseReader = { read: async () => (read++, { fields: {} }) };
    const msg = (text: string): QueuedMessage => ({ id: `wa-${randomUUID()}`, chatId: "919800000003@c.us", from: who, lid: null, at: new Date().toISOString(), text });
    const m = msg("Mera naam Ravi Kumar hai, 5000 UPI se gaye");
    expect(await queueInbound(tenant, m)).toBe(true);
    expect(await queueInbound(tenant, m)).toBe(false); // OpenWA retried the same delivery
    expect(await processInbox(tenant, reader, wa)).toEqual({ handled: 1, failed: 0 });
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe(who);
    expect(wa.sent[0]!.body).toContain("To report a cyber crime, please call our helpline");
    expect(wa.sent[0]!.body).toContain("साइबर अपराध की शिकायत के लिए कृपया हमारी हेल्पलाइन");
    expect(read).toBe(0); // nothing of theirs is read or kept as a complaint
    expect(await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, who)))).toHaveLength(0);
    // A second message soon after gets no second greeting.
    await queueInbound(tenant, msg("hello?"));
    expect(await processInbox(tenant, reader, wa)).toEqual({ handled: 1, failed: 0 });
    expect(wa.sent).toHaveLength(1);
    expect(await processInbox(tenant, reader, wa)).toEqual({ handled: 0, failed: 0 });
  });

  it("keeps a message it could not read, tries again after a widening gap, and keeps that person's later messages behind it", async () => {
    // Both have called the helpline, so their replies are read.
    for (const who of ["+919800000004", "+919800000014"])
      await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: who, contactId: null, branchId: null, extracted: { complaint_type: "UPI fraud", money_lost: "700", how_it_happened: "Paid a fake seller" } }, new SimulatedWhatsApp()));
    const wa = new SimulatedWhatsApp();
    const broken: CaseReader = { read: async () => { throw new Error("database went away"); } };
    const msg = (who: string, text: string): QueuedMessage => ({ id: `wa-${randomUUID()}`, chatId: `${who.slice(1)}@c.us`, from: who, lid: null, at: new Date().toISOString(), text });
    const first = msg("+919800000004", "hello");
    await queueInbound(tenant, first);
    expect(await processInbox(tenant, broken, wa)).toEqual({ handled: 0, failed: 1 });
    const [row] = await withTenant(tenant, (tx) => tx.select().from(whatsappInbox).where(eq(whatsappInbox.externalId, first.id)));
    expect(row!.processedAt).toBeNull();
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toMatch(/database went away/);
    // Not tried again at once; the same person's next message waits behind it, someone else's does not.
    await queueInbound(tenant, msg("+919800000004", "second"));
    const other = msg("+919800000014", "namaste");
    await queueInbound(tenant, other);
    expect(await processInbox(tenant, new ScriptedReader({}), wa)).toEqual({ handled: 1, failed: 0 });
    expect(wa.sent.map((s) => s.to)).toEqual(["+919800000014"]);
    // 15 seconds on, both of the first person's messages are read, in order.
    await withTenant(tenant, (tx) => tx.update(whatsappInbox).set({ receivedAt: new Date(Date.now() - 20_000) }).where(eq(whatsappInbox.externalId, first.id)));
    expect(await processInbox(tenant, new ScriptedReader({}), wa)).toEqual({ handled: 2, failed: 0 });
  });

  it("puts the messages that could not be read back for another try", async () => {
    await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: "+919800000024", contactId: null, branchId: null, extracted: { complaint_type: "UPI fraud", money_lost: "700", how_it_happened: "Paid a fake seller" } }, new SimulatedWhatsApp()));
    const m: QueuedMessage = { id: `wa-${randomUUID()}`, chatId: "919800000024@c.us", from: "+919800000024", lid: null, at: new Date().toISOString(), text: "hello" };
    await queueInbound(tenant, m);
    await withTenant(tenant, (tx) => tx.update(whatsappInbox).set({ attempts: INBOX_MAX_ATTEMPTS, lastError: "gave up" }).where(eq(whatsappInbox.externalId, m.id)));
    expect(await processInbox(tenant, new ScriptedReader({}), new SimulatedWhatsApp())).toEqual({ handled: 0, failed: 0 });
    expect(await retryInbox(tenant)).toBe(1);
    expect(await processInbox(tenant, new ScriptedReader({}), new SimulatedWhatsApp())).toEqual({ handled: 1, failed: 0 });
  });

  it("asks someone whose number WhatsApp hides for it, on their private chat, and greets them when they never called", async () => {
    expect(chatIdFor("lid:12345678901234")).toBe("12345678901234@lid");
    expect(chatIdFor("+919800000001")).toBe("919800000001@c.us");
    const wa = new SimulatedWhatsApp();
    const hook = parseOpenWaWebhook({ event: "message.received", sessionId: "s", data: { id: "lid-m1", from: "12345678901234@lid", chatId: "12345678901234@lid", body: "mere saath fraud hua", type: "text", contact: { pushName: "Ravi" } } });
    if (hook?.kind !== "message") throw new Error("not a message");
    expect(hook.message).toMatchObject({ from: null, lid: "12345678901234@lid", name: "Ravi" });
    await queueInbound(tenant, hook.message);
    const reader = new ResilientReader(null);
    expect(await processInbox(tenant, reader, wa)).toEqual({ handled: 1, failed: 0 });
    expect(wa.sent.at(-1)!.to).toBe("lid:12345678901234");
    expect(wa.sent.at(-1)!.body).toContain("WhatsApp does not show us your number");
    const [c] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, "lid:12345678901234")));
    expect(c!.fields).toMatchObject({ number_hidden: "yes", whatsapp_name: "Ravi" });
    expect(complainantNumber(c!)).toBeNull();
    await handleInbound(tenant, { from: "lid:12345678901234", id: randomUUID(), at: new Date(), text: "98000 00071" }, reader, wa);
    const [after] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.id, c!.id)));
    expect(after!.fields.mobile_number).toBe("+919800000071");
    expect(complainantNumber(after!)).toBe("+919800000071");
    // No call from that number: the department's greeting, on the private chat, and the chat closes.
    expect(wa.sent.at(-1)!.to).toBe("lid:12345678901234");
    expect(wa.sent.at(-1)!.body).toContain("To report a cyber crime, please call our helpline");
    expect(after!.status).toBe("closed");
  });

  it("joins a hidden-number chat to the caller's complaint once they give the number they called from", async () => {
    const wa = new SimulatedWhatsApp();
    const phone = "+919800000072";
    const call = await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone, contactId: null, branchId: null, extracted: { complaint_type: "UPI fraud", money_lost: "7000", complainant_name: "Neha Bisht", how_it_happened: "Paid a fake seller on OLX" } }, wa));
    expect(wa.sent.at(-1)!.body).toContain("father's or husband's name");
    // WhatsApp now shows the same person only by a private id.
    const reader = new ResilientReader(null);
    const say = (text: string) => handleInbound(tenant, { from: "lid:555550000072", id: randomUUID(), at: new Date(), text }, reader, wa);
    await say("Mohan Bisht");
    expect(wa.sent.at(-1)!.body).toContain("WhatsApp does not show us your number");
    await say("9800000072");
    expect(wa.sent.at(-1)!.to).toBe("lid:555550000072");
    expect(wa.sent.at(-1)!.body).toMatch(/We found your complaint CY-\d{4}-\d{6}; let us continue it here\./);
    expect(wa.sent.at(-1)!.body).toContain("father's or husband's name");
    const [joined] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.id, call!.id)));
    expect(joined!.fields.whatsapp_lid).toBe("lid:555550000072");
    expect(joined!.fields.complainant_name).toBe("Neha Bisht"); // the complaint keeps its own answers
    const [chat] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, "lid:555550000072")));
    expect(chat!.status).toBe("closed");
    expect(chat!.officerNote).toMatch(/Same person as complaint CY-/);
    const moved = await withTenant(tenant, (tx) => tx.select().from(caseMessages).where(eq(caseMessages.caseId, call!.id)));
    expect(moved.filter((m) => m.direction === "in").map((m) => m.body)).toEqual(["Mohan Bisht", "9800000072"]);
    // The private chat's next reply lands in the caller's complaint.
    await say("F: Mohan Bisht");
    const [next] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.id, call!.id)));
    expect(next!.fields.father_or_husband_name).toBe("F: Mohan Bisht");
    expect(wa.sent.at(-1)!.body).toContain("3. What is your date of birth?");
  });

  it("stores a photo that arrived inside the webhook without asking the gateway again", async () => {
    await withTenant(tenant, (tx) => caseFromCall(tx, tenant, { id: randomUUID(), phone: "+919800000005", contactId: null, branchId: null, extracted: { complaint_type: "UPI fraud", money_lost: "700", how_it_happened: "Paid a fake seller" } }, new SimulatedWhatsApp()));
    const wa = new SimulatedWhatsApp(); // has no media: a download attempt would fail
    const m: QueuedMessage = { id: `wa-${randomUUID()}`, chatId: "919800000005@c.us", from: "+919800000005", lid: null, at: new Date().toISOString(), text: "screenshot", media: { kind: "image", mime: "image/png", dataBase64: Buffer.from("png-bytes").toString("base64") } };
    await queueInbound(tenant, m);
    expect(await processInbox(tenant, new ScriptedReader({}), wa)).toEqual({ handled: 1, failed: 0 });
    const ev = await withTenant(tenant, (tx) => tx.select().from(caseEvidence).where(eq(caseEvidence.externalId, `919800000005@c.us/${m.id}`)));
    expect(ev[0]!.bytes!.toString()).toBe("png-bytes");
    expect(ev[0]!.caption).toBe("screenshot");
  });
});

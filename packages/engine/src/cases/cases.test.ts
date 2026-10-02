/**
 * Cases end to end against real Postgres (row-level security on), with a
 * simulated WhatsApp and a scripted reader standing in for the model.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { caseEvidence, caseMessages, cases, organizations, platformDb, whatsappChannels, whatsappInbox, withTenant } from "@jenai/db";
import { scamKeyFromText } from "../scams";
import { caseFromCall, fieldsFromCall, handleInbound, parseRead, remindPending, type CaseReader, type ReadResult } from "./cases";
import { missingFor, questionFor, reminderText } from "./catalog";
import { processInbox, queueInbound } from "./inbox";
import { SimulatedWhatsApp, parseOpenWaWebhook, validSignature, type QueuedMessage } from "./whatsapp";
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
    expect(money).toEqual(["complainant_name", "father_or_husband_name", "date_of_birth", "house_number", "present_address", "police_station", "district", "pincode", "victim_bank_and_account", "transactions", "money_lost", "how_it_happened", "fraudster_details", "apk_or_link", "proof"]);
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
    expect(c!.missing).toHaveLength(12);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.body).toMatch(/शिकायत संख्या CY-\d{4}-000001/);
    expect(wa.sent[0]!.body).toContain("पिता या पति");
    expect(wa.sent[0]!.body).toContain("father's or husband's name");
    expect(wa.sent[0]!.body).toContain("Your complaint number is CY-");
  });

  it("a second call from the same person adds to the same case, without a second WhatsApp", async () => {
    await call({ complaint_type: "UPI fraud", fraudster_mobile: "9000000001", whatsapp_consent: "yes" });
    const all = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, phone)));
    expect(all).toHaveLength(1);
    expect(all[0]!.fields.fraudster_mobile).toBe("9000000001");
    expect(wa.sent).toHaveLength(1);
  });

  it("takes the form one line at a time, re-asks an answer in the wrong shape, stores proof, and hands the case over", async () => {
    const reader = new ScriptedReader({
      "Sainath Tangallapalli": { fields: { complainant_name: "Sainath Tangallapalli" } },
      "Sadanandam": { fields: { father_or_husband_name: "F: Sadanandam" } },
      "15/08/1990": { fields: { date_of_birth: "1990-08-15" } },
      "12-4": { fields: { house_number: "12-4" } },
      "Shanti Vihar, Rishikesh": { fields: { present_address: "Shanti Vihar, Rishikesh" } },
      "Rishikesh thana": { fields: { police_station: "Rishikesh" } },
      "Dehradun": { fields: { district: "Dehradun" } },
      "24920": { fields: { pincode: "24920" } },
      "249201": { fields: { pincode: "249201" } },
      "SBI 30012345678": { fields: { victim_bank_and_account: "SBI; 30012345678" } },
      "UTR 412345678901, 40000, 28 Sep": { fields: { transactions: "40000 | 28 Sep | 412345678901" } },
      "40000": { fields: { money_lost: "40000" } },
      "Clicked a loan link and paid by UPI": { fields: { how_it_happened: "Clicked a loan link and paid by UPI" } },
      "no": { fields: { apk_or_link: "no" } },
    });
    const say = (text: string) => handleInbound(tenant, { from: phone, id: randomUUID(), at: new Date(), text }, reader, wa);
    await say("Sadanandam");
    expect(wa.sent.at(-1)!.body).toContain("जन्म तिथि");
    for (const t of ["15/08/1990", "12-4", "Shanti Vihar, Rishikesh", "Rishikesh thana", "Dehradun"]) await say(t);
    expect(wa.sent.at(-1)!.body).toContain("पिनकोड");
    await say("24920"); // five digits
    expect(wa.sent.at(-1)!.body).toContain("6 अंकों");
    expect(wa.sent.at(-1)!.body).toContain("8. आपके क्षेत्र का पिनकोड");
    for (const t of ["249201", "SBI 30012345678", "UTR 412345678901, 40000, 28 Sep"]) await say(t);
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

  it("queues each message once and answers it from the worker", async () => {
    const wa = new SimulatedWhatsApp();
    const who = "+919800000003";
    const reader = new ScriptedReader({ "Mera naam Ravi Kumar hai, 5000 UPI se gaye": { fields: { complainant_name: "Ravi Kumar", incident_description: "Lost 5000 by UPI" }, scam_type: "upi_bank_card" } });
    const m: QueuedMessage = { id: `wa-${randomUUID()}`, chatId: "919800000003@c.us", from: who, lid: null, at: new Date().toISOString(), text: "Mera naam Ravi Kumar hai, 5000 UPI se gaye" };
    expect(await queueInbound(tenant, m)).toBe(true);
    expect(await queueInbound(tenant, m)).toBe(false); // OpenWA retried the same delivery
    expect(await processInbox(tenant, reader, wa)).toEqual({ handled: 1, failed: 0 });
    const [c] = await withTenant(tenant, (tx) => tx.select().from(cases).where(eq(cases.complainantE164, who)));
    expect(c!.fields.complainant_name).toBe("Ravi Kumar");
    expect(c!.scamType).toBe("upi_bank_card");
    expect(wa.sent.at(-1)!.to).toBe(who);
    expect(wa.sent.at(-1)!.body).toContain("पिता या पति");
    expect(await processInbox(tenant, reader, wa)).toEqual({ handled: 0, failed: 0 });
  });

  it("keeps a message it could not read, and retries it", async () => {
    const wa = new SimulatedWhatsApp();
    const broken: CaseReader = { read: async () => { throw new Error("model is not running"); } };
    const m: QueuedMessage = { id: `wa-${randomUUID()}`, chatId: "919800000004@c.us", from: "+919800000004", lid: null, at: new Date().toISOString(), text: "hello" };
    await queueInbound(tenant, m);
    expect(await processInbox(tenant, broken, wa)).toEqual({ handled: 0, failed: 1 });
    const [row] = await withTenant(tenant, (tx) => tx.select().from(whatsappInbox).where(eq(whatsappInbox.externalId, m.id)));
    expect(row!.processedAt).toBeNull();
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toMatch(/model is not running/);
    expect(await processInbox(tenant, new ScriptedReader({}), wa)).toEqual({ handled: 1, failed: 0 });
  });

  it("stores a photo that arrived inside the webhook without asking the gateway again", async () => {
    const wa = new SimulatedWhatsApp(); // has no media: a download attempt would fail
    const m: QueuedMessage = { id: `wa-${randomUUID()}`, chatId: "919800000005@c.us", from: "+919800000005", lid: null, at: new Date().toISOString(), text: "screenshot", media: { kind: "image", mime: "image/png", dataBase64: Buffer.from("png-bytes").toString("base64") } };
    await queueInbound(tenant, m);
    expect(await processInbox(tenant, new ScriptedReader({}), wa)).toEqual({ handled: 1, failed: 0 });
    const ev = await withTenant(tenant, (tx) => tx.select().from(caseEvidence).where(eq(caseEvidence.externalId, `919800000005@c.us/${m.id}`)));
    expect(ev[0]!.bytes!.toString()).toBe("png-bytes");
    expect(ev[0]!.caption).toBe("screenshot");
  });
});

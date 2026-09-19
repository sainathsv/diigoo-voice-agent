import { describe, expect, it } from "vitest";
import { cleanExtraction } from "./analyze";

describe("cleanExtraction", () => {
  it("accepts a well-formed answer, even wrapped in prose", () => {
    const x = cleanExtraction('Sure: {"caller_name":"Ravi","concern":"hair fall treatment","preferred_time":"20 Sep 2026, 11:00 AM","interest_level":"hot","next_step":"booked","do_not_call":false,"summary":"Booked a consultation."}');
    expect(x).toMatchObject({ caller_name: "Ravi", next_step: "booked", preferred_time: "20 Sep 2026, 11:00 AM" });
  });
  it("drops a literal format string instead of storing it as a date", () => {
    const x = cleanExtraction({ caller_name: null, concern: "acne", preferred_time: "DD Mon YYYY, 3:00 PM", interest_level: "warm", next_step: "booked", do_not_call: null, summary: null });
    expect(x!.preferred_time).toBeNull();
    expect(x!.next_step).toBe("callback"); // a booking needs a real day and time
  });
  it("nulls out values outside the allowed set", () => {
    const x = cleanExtraction({ interest_level: "very hot", next_step: "maybe", do_not_call: "yes" });
    expect(x).toMatchObject({ interest_level: null, next_step: null, do_not_call: null });
  });
  it("returns null for non-JSON output", () => {
    expect(cleanExtraction("I could not understand the call.")).toBeNull();
  });
});

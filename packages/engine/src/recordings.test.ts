/** Recordings kept on a client's own server: the stored type and the bytes a player asks for. */
import { describe, expect, it } from "vitest";
import { audioType, byteRange } from "./recordings";

describe("recordings kept on this server", () => {
  it("stores the engine's audio type, or reads it from the file when the engine does not say", () => {
    expect(audioType("audio/x-wav; charset=binary", Buffer.from("RIFF"))).toBe("audio/x-wav");
    expect(audioType("application/octet-stream", Buffer.from("RIFF...."))).toBe("audio/wav");
    expect(audioType("binary/octet-stream", Buffer.from("OggS...."))).toBe("audio/ogg");
    expect(audioType(null, Buffer.from("ID3\x04...."))).toBe("audio/mpeg");
  });

  it("answers a player's Range with just those bytes", () => {
    expect(byteRange(null, 1000)).toEqual({ start: 0, end: 999, partial: false });
    expect(byteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999, partial: true });
    expect(byteRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199, partial: true });
    expect(byteRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999, partial: true }); // clipped to the file
    expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999, partial: true }); // the last 100 bytes
    expect(byteRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999, partial: true });
  });

  it("refuses a range past the end, and sends the whole file for one it does not handle", () => {
    expect(byteRange("bytes=1000-", 1000)).toBeNull();
    expect(byteRange("bytes=-0", 1000)).toBeNull();
    expect(byteRange("bytes=0-1,5-6", 1000)).toEqual({ start: 0, end: 999, partial: false });
    expect(byteRange("items=0-5", 1000)).toEqual({ start: 0, end: 999, partial: false });
  });
});

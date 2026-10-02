/**
 * Recordings kept on a client's own server (JENAI_STORE_RECORDINGS=true): copied
 * from the voice engine when a call is synced, and played back from here.
 */
import { createHash } from "node:crypto";
import type { DograhClient } from "@jenai/voice";

export type Recording = { bytes: Buffer; mime: string; sha256: string };

/** Largest recording copied to this server; 100 MB is well over an hour of telephone audio. */
const recordingCap = () => Math.max(1, Number(process.env.JENAI_RECORDING_MAX_MB ?? 100)) * 1_048_576;

/** The stored type: the engine's when it says audio, otherwise read from the file's first bytes. */
export function audioType(declared: string | null, b: Buffer): string {
  const t = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (t.startsWith("audio/")) return t;
  const head = b.subarray(0, 4).toString("latin1");
  return head === "OggS" ? "audio/ogg" : head.startsWith("ID3") ? "audio/mpeg" : "audio/wav";
}

/**
 * Copies a finished call's recording to this server. When the engine does not hand it
 * over (or it is over the size limit) the reason comes back instead, and the call is retried.
 */
export async function copyRecording(client: DograhClient, url: string): Promise<Recording | string> {
  try {
    const res = await client.fetchArtifact(url, undefined, 120_000);
    if (!res.ok) {
      await res.body?.cancel();
      return `download refused (${res.status})`;
    }
    const max = recordingCap();
    const tooBig = `over ${max / 1_048_576} MB`;
    if (Number(res.headers.get("content-length") ?? 0) > max) {
      await res.body?.cancel();
      return tooBig;
    }
    if (!res.body) return "empty file";
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return tooBig;
      }
      parts.push(value);
    }
    if (!size) return "empty file";
    const bytes = Buffer.concat(parts);
    return { bytes, mime: audioType(res.headers.get("content-type"), bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * The bytes to send for a player's Range header, or null when the range cannot be met
 * (answer 416). One range is honoured; no Range, or several, means the whole file,
 * which the standard allows.
 */
export function byteRange(range: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, partial: false };
  let start: number;
  let end = size - 1;
  if (m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else start = Math.max(0, size - Number(m[2])); // "bytes=-N": the last N bytes
  return start > end ? null : { start, end, partial: true };
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard (red-team finding 2026-09-19). The engine address is entered by
 * staff and redirects come from the engine; neither may point the server at
 * internal networks or the cloud metadata service (169.254.169.254).
 *
 * Private hosts are allowed only when explicitly listed:
 *   JENAI_ALLOWED_PRIVATE_HOSTS=minio:9000,api:8000   (inside the engine's network)
 *   JENAI_ALLOW_PRIVATE_ENGINE=true                    (tests and local fakes only)
 * Egress rules on the server remain the second line of defence (DNS rebinding).
 */

function v4ToInt(a: string) {
  return a.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
function inCidr(ip: string, cidr: string) {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base!) & mask);
}
const V4_BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"];

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4_BLOCKED.some((c) => inCidr(ip, c));
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  return true; // not an IP at all: refuse
}

export class BlockedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Blocked address ${new URL(url).host}: ${reason}`);
    this.name = "BlockedUrlError";
  }
}

function allowedPrivate(u: URL): boolean {
  if (process.env.JENAI_ALLOW_PRIVATE_ENGINE === "true") return true;
  const list = (process.env.JENAI_ALLOWED_PRIVATE_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(u.host.toLowerCase()) || list.includes(u.hostname.toLowerCase());
}

/** Throws unless the URL is http(s) and every address it resolves to is public (or explicitly allowed). */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError("http://invalid", "not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BlockedUrlError(raw, "only http and https are allowed");
  if (u.username || u.password) throw new BlockedUrlError(raw, "credentials in URLs are not allowed");
  if (allowedPrivate(u)) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) throw new BlockedUrlError(raw, "host does not resolve");
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new BlockedUrlError(raw, `resolves to a private or internal address (${bad.address})`);
  return u;
}

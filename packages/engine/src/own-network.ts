/** This machine or its own network: loopback, private ranges, Tailscale, or a one-word name such as a container's. */
export function isOnOwnNetwork(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1") return true;
  if (host.includes(":")) return /^(f[cd]|fe[89ab])/.test(host); // IPv6: unique local or link-local only
  if (!host.includes(".")) return host !== "";
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const [a, b] = host.split(".").map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

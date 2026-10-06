/**
 * The government telephone line, as this server sees it: the cable on its own
 * Ethernet port, the network address on that port, the telecom team's SIP system
 * and (once it is set up) our telephone gateway and an automatic AI test call.
 * The worker checks it every minute; the portal's home page shows the result with
 * what to do. Nothing here guesses the telecom team's settings: a check that needs
 * one of their details waits for it, and the only address ever contacted is the one
 * configured in JENAI_TEL_SIP_PEER.
 */
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile, readdir, access } from "node:fs/promises";
import { networkInterfaces } from "node:os";

export type CheckState = "ok" | "fail" | "waiting";

export interface LineCheck {
  key: "port" | "cable" | "address" | "telecom" | "gateway" | "test_call";
  label: string;
  state: CheckState;
  detail: string;
  /** What to do about it, in plain words. */
  fix?: string;
}

export interface LineStatus {
  checkedAt: string;
  iface: string | null;
  overall: CheckState;
  checks: LineCheck[];
}

export interface LineConfig {
  /** The Ethernet port the government cable is plugged into, or "auto" for the one spare port. */
  iface: string;
  /** The telecom team's SIP address, host or host:port, once they give it. */
  sipPeer: string | null;
  /** Our telephone gateway's health address (set when the gateway is installed): http(s)://… or tcp://host:port. */
  gatewayHealthUrl: string | null;
}

/** Monitoring is on when JENAI_TEL_IFACE is set (a port name, or "auto"). */
export function lineConfigFromEnv(env: Record<string, string | undefined> = process.env): LineConfig | null {
  const iface = env.JENAI_TEL_IFACE?.trim();
  if (!iface) return null;
  if (iface !== "auto" && !/^[a-zA-Z0-9_.:-]{1,15}$/.test(iface)) throw new Error("JENAI_TEL_IFACE must be a network port name (for example the second Ethernet port) or auto");
  return { iface, sipPeer: env.JENAI_TEL_SIP_PEER?.trim() || null, gatewayHealthUrl: env.JENAI_TEL_GATEWAY_HEALTH_URL?.trim() || null };
}

export interface PortFacts {
  name: string;
  /** A real network card (not loopback, Docker, Tailscale, a bridge or a VPN). */
  physical: boolean;
  /** true: a cable is in and the other end is on; false: no link; null: unknown (port down). */
  carrier: boolean | null;
  operstate: string | null;
  ipv4: string[];
}

export interface NetFacts {
  ports: PortFacts[];
  /** The port that carries this server's default route (its office network), if any. */
  defaultRoute: string | null;
}

const readText = (p: string) => readFile(p, "utf8").then((s) => s.trim()).catch(() => null);

/** What Linux reports about this server's network ports. */
export async function readNetFacts(): Promise<NetFacts> {
  const names = await readdir("/sys/class/net").catch(() => [] as string[]);
  const addrs = networkInterfaces();
  const ports: PortFacts[] = [];
  for (const name of names) {
    const physical = await access(`/sys/class/net/${name}/device`).then(() => true, () => false);
    const carrier = await readText(`/sys/class/net/${name}/carrier`);
    ports.push({
      name,
      physical: physical && !/^(lo|docker|br-|veth|tailscale|tun|tap|virbr|wg)/.test(name),
      carrier: carrier === "1" ? true : carrier === "0" ? false : null,
      operstate: await readText(`/sys/class/net/${name}/operstate`),
      ipv4: (addrs[name] ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address),
    });
  }
  const routes = (await readText("/proc/net/route")) ?? "";
  const def = routes.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).find((f) => f[1] === "00000000");
  return { ports, defaultRoute: def?.[0] ?? null };
}

/**
 * The port the government cable is on: the named one, or with "auto" the one
 * physical Ethernet port that is not this server's office network (a port with a
 * cable in wins). Two or more spare ports are ambiguous: then nothing is guessed.
 */
export function pickPort(cfg: LineConfig, facts: NetFacts): { port: PortFacts | null; why?: string } {
  if (cfg.iface !== "auto") {
    const port = facts.ports.find((p) => p.name === cfg.iface) ?? null;
    return port ? { port } : { port: null, why: `There is no network port named ${cfg.iface} on this server.` };
  }
  const spare = facts.ports.filter((p) => p.physical && p.name !== facts.defaultRoute);
  const linked = spare.filter((p) => p.carrier);
  if (linked.length === 1) return { port: linked[0]! };
  if (spare.length === 1) return { port: spare[0]! };
  if (!spare.length) return { port: null, why: "This server has no spare Ethernet port for the government cable: all its ports carry the office network." };
  return { port: null, why: `This server has ${spare.length} spare Ethernet ports (${spare.map((p) => p.name).join(", ")}); name the one for the government cable in JENAI_TEL_IFACE.` };
}

/**
 * A SIP OPTIONS request (the standard "are you there" of telephone systems) over
 * UDP to the configured peer. Any SIP reply counts as reachable; the status is reported.
 */
export async function sipOptions(peer: string, timeoutMs = 3000): Promise<{ ok: boolean; status?: number; ms?: number; error?: string }> {
  const [host, portText] = peer.includes(":") ? [peer.slice(0, peer.lastIndexOf(":")), peer.slice(peer.lastIndexOf(":") + 1)] : [peer, "5060"];
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `not a SIP address: ${peer}` };
  const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
  const branch = `z9hG4bK${randomBytes(6).toString("hex")}`;
  const tag = randomBytes(4).toString("hex");
  const callId = `${randomBytes(8).toString("hex")}@jenai`;
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (r: { ok: boolean; status?: number; ms?: number; error?: string }) => {
      clearTimeout(timer);
      sock.close();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: `no answer within ${timeoutMs / 1000} s` }), timeoutMs);
    sock.on("error", (e) => done({ ok: false, error: e.message }));
    sock.on("message", (buf) => {
      const m = /^SIP\/2\.0 (\d{3})/.exec(buf.toString("latin1"));
      if (m && buf.toString("latin1").includes(callId)) done({ ok: true, status: Number(m[1]), ms: Date.now() - started });
    });
    sock.bind(0, () => {
      const local = sock.address();
      const msg = [
        `OPTIONS sip:${host}:${port} SIP/2.0`,
        `Via: SIP/2.0/UDP ${local.address === "0.0.0.0" || local.address === "::" ? "127.0.0.1" : local.address}:${local.port};branch=${branch};rport`,
        "Max-Forwards: 70",
        `From: <sip:jenai-monitor@${host}>;tag=${tag}`,
        `To: <sip:${host}:${port}>`,
        `Call-ID: ${callId}`,
        "CSeq: 1 OPTIONS",
        "User-Agent: JENAI line monitor",
        "Accept: application/sdp",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n");
      sock.send(msg, port, host, (e) => e && done({ ok: false, error: e.message }));
    });
  });
}

/** The gateway answers: an HTTP health address returns 200, or a tcp://host:port accepts a connection (Asterisk's ARI). */
export async function gatewayUp(url: string, timeoutMs = 3000): Promise<boolean> {
  const tcp = /^tcp:\/\/([^:/\s]+):(\d{1,5})$/.exec(url);
  if (!tcp) return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null))?.ok ?? false;
  return new Promise((resolve) => {
    const s = connect({ host: tcp[1]!, port: Number(tcp[2]) });
    const done = (up: boolean) => {
      s.destroy();
      resolve(up);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const RANK: Record<CheckState, number> = { ok: 0, waiting: 1, fail: 2 };

/** Runs every check once. The facts and the SIP probe are passed in so tests need no real network. */
export async function checkLine(
  cfg: LineConfig,
  facts: NetFacts,
  probes: { sip: typeof sipOptions; gateway: (url: string) => Promise<boolean> } = { sip: sipOptions, gateway: (u) => gatewayUp(u) },
): Promise<LineStatus> {
  const checks: LineCheck[] = [];
  const { port, why } = pickPort(cfg, facts);
  checks.push(
    port
      ? { key: "port", label: "Cable port", state: "ok", detail: `Port ${port.name}${cfg.iface === "auto" ? " (found by itself)" : ""}` }
      : { key: "port", label: "Cable port", state: "fail", detail: why!, fix: "Plug the government cable into the server's spare Ethernet port, or set JENAI_TEL_IFACE to its name." },
  );
  const linked = !!port?.carrier;
  checks.push(
    !port
      ? { key: "cable", label: "Cable connected", state: "waiting", detail: "Waiting for the cable port." }
      : linked
        ? { key: "cable", label: "Cable connected", state: "ok", detail: `Link is up on ${port.name}.` }
        : { key: "cable", label: "Cable connected", state: "fail", detail: `No link on ${port.name}.`, fix: "Check that the cable is pushed in at both ends and that the telecom team's side is switched on. The port light should glow." },
  );
  const ip = port?.ipv4[0];
  checks.push(
    !linked
      ? { key: "address", label: "Network address", state: "waiting", detail: "Waiting for the cable." }
      : ip
        ? { key: "address", label: "Network address", state: "ok", detail: `${port!.name} has ${port!.ipv4.join(", ")}.` }
        : { key: "address", label: "Network address", state: "fail", detail: `${port!.name} has no network address yet.`, fix: "The telecom team gives either automatic addressing (DHCP) or a fixed address; set that on this port. Do not guess it." },
  );
  if (!cfg.sipPeer) checks.push({ key: "telecom", label: "Telecom telephone system", state: "waiting", detail: "Waiting for the telecom team's SIP address and settings.", fix: "Ask the telecom team for the questions in the integration checklist, then set JENAI_TEL_SIP_PEER." });
  else if (!ip) checks.push({ key: "telecom", label: "Telecom telephone system", state: "waiting", detail: "Waiting for a network address on the cable port." });
  else {
    const r = await probes.sip(cfg.sipPeer);
    checks.push(
      r.ok
        ? { key: "telecom", label: "Telecom telephone system", state: "ok", detail: `${cfg.sipPeer} answered in ${r.ms} ms (SIP ${r.status}).` }
        : { key: "telecom", label: "Telecom telephone system", state: "fail", detail: `${cfg.sipPeer} did not answer: ${r.error ?? "no reply"}.`, fix: "Ask the telecom team to confirm the SIP address, port and transport, and that our address is allowed on their side." },
    );
  }
  if (!cfg.gatewayHealthUrl) checks.push({ key: "gateway", label: "Telephone gateway", state: "waiting", detail: "Not set up yet: it is configured from the telecom team's answers." });
  else {
    const up = await probes.gateway(cfg.gatewayHealthUrl);
    checks.push(up ? { key: "gateway", label: "Telephone gateway", state: "ok", detail: "Running." } : { key: "gateway", label: "Telephone gateway", state: "fail", detail: "Not answering.", fix: "It restarts by itself; if this stays red, see the troubleshooting guide." });
  }
  checks.push({ key: "test_call", label: "Automatic AI test call", state: "waiting", detail: "Runs every few minutes once the gateway is set up, and shows whether a caller hears the AI." });
  const overall = checks.reduce<CheckState>((w, c) => (RANK[c.state] > RANK[w] ? c.state : w), "ok");
  return { checkedAt: new Date().toISOString(), iface: port?.name ?? null, overall, checks };
}

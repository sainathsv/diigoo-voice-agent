/** The government telephone line checks, with made-up network facts and a local stand-in SIP system. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { checkLine, gatewayUp, lineConfigFromEnv, parseAsteriskStatus, pickPort, sipOptions, type NetFacts } from "./telephone-line";

const office = { name: "eno1", physical: true, carrier: true, operstate: "up", ipv4: ["192.168.2.185"] };
const facts = (spare: Partial<NetFacts["ports"][number]> | null, more: NetFacts["ports"] = []): NetFacts => ({
  defaultRoute: "eno1",
  ports: [office, { name: "lo", physical: false, carrier: true, operstate: "unknown", ipv4: [] }, { name: "docker0", physical: false, carrier: false, operstate: "down", ipv4: ["172.17.0.1"] }, ...(spare ? [{ name: "enp2s0", physical: true, carrier: false, operstate: "down", ipv4: [], ...spare }] : []), ...more],
});
const noSip = async () => ({ ok: false, error: "not called" });

describe("telephone line", () => {
  it("is off until a port is named, and refuses a malformed name", () => {
    expect(lineConfigFromEnv({})).toBeNull();
    expect(lineConfigFromEnv({ JENAI_TEL_IFACE: "auto" })).toEqual({ iface: "auto", sipPeer: null, gatewayHealthUrl: null });
    expect(() => lineConfigFromEnv({ JENAI_TEL_IFACE: "eth1; rm -rf /" })).toThrow(/port name/);
  });

  it("finds the one spare Ethernet port by itself, and never guesses between two", () => {
    expect(pickPort({ iface: "auto", sipPeer: null, gatewayHealthUrl: null }, facts({})).port?.name).toBe("enp2s0");
    const two = facts({}, [{ name: "enp3s0", physical: true, carrier: false, operstate: "down", ipv4: [] }]);
    expect(pickPort({ iface: "auto", sipPeer: null, gatewayHealthUrl: null }, two)).toMatchObject({ port: null, why: expect.stringMatching(/2 spare Ethernet ports/) });
    // ...unless only one of them has a cable in.
    const oneLinked = facts({ carrier: true }, [{ name: "enp3s0", physical: true, carrier: false, operstate: "down", ipv4: [] }]);
    expect(pickPort({ iface: "auto", sipPeer: null, gatewayHealthUrl: null }, oneLinked).port?.name).toBe("enp2s0");
    expect(pickPort({ iface: "auto", sipPeer: null, gatewayHealthUrl: null }, facts(null)).why).toMatch(/no spare Ethernet port/);
  });

  it("says the cable is out, then waits for an address, then waits for the telecom team's details", async () => {
    const cfg = { iface: "auto", sipPeer: null, gatewayHealthUrl: null };
    const out = await checkLine(cfg, facts({ carrier: false }), { sip: noSip, gateway: async () => false });
    expect(out.overall).toBe("fail");
    expect(out.checks.find((c) => c.key === "cable")).toMatchObject({ state: "fail", fix: expect.stringMatching(/cable/) });
    const noIp = await checkLine(cfg, facts({ carrier: true, operstate: "up" }), { sip: noSip, gateway: async () => false });
    expect(noIp.checks.find((c) => c.key === "address")).toMatchObject({ state: "fail", fix: expect.stringMatching(/Do not guess/) });
    const ready = await checkLine(cfg, facts({ carrier: true, operstate: "up", ipv4: ["10.1.2.3"] }), { sip: noSip, gateway: async () => false });
    expect(ready.overall).toBe("waiting");
    expect(ready.checks.map((c) => [c.key, c.state])).toEqual([["port", "ok"], ["cable", "ok"], ["address", "ok"], ["telecom", "waiting"], ["gateway", "waiting"], ["test_call", "waiting"]]);
  });

  it("asks the telecom system 'are you there' over SIP, and reports a silent one", async () => {
    const peer = createSocket("udp4");
    const via: string[] = [];
    peer.on("message", (msg, rinfo) => {
      const text = msg.toString("latin1");
      const callId = /Call-ID: (.+)\r\n/.exec(text)![1];
      via.push(`${/Via: SIP\/2\.0\/UDP ([^;]+);/.exec(text)![1]} from ${rinfo.address}:${rinfo.port}`);
      peer.send(`SIP/2.0 200 OK\r\nCall-ID: ${callId}\r\nContent-Length: 0\r\n\r\n`, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", () => r()));
    const at = `127.0.0.1:${(peer.address() as AddressInfo).port}`;
    const r = await sipOptions(at, 2000);
    expect(r).toMatchObject({ ok: true, status: 200 });
    // The Via header names the address the request really comes from, so a reply sent there arrives.
    expect(via[0]).toMatch(/^(127\.0\.0\.1:\d+) from \1$/);
    const line = await checkLine({ iface: "enp2s0", sipPeer: at, gatewayHealthUrl: null }, facts({ carrier: true, operstate: "up", ipv4: ["10.1.2.3"] }), { sip: sipOptions, gateway: async () => false });
    expect(line.checks.find((c) => c.key === "telecom")).toMatchObject({ state: "ok", detail: expect.stringMatching(/answered in \d+ ms \(SIP 200\)/) });
    peer.close();
    const silent = await sipOptions("127.0.0.1:9", 500);
    expect(silent.ok).toBe(false);
    expect(await sipOptions("not an address:99999")).toMatchObject({ ok: false });
  });
});

/** A throwaway self-signed certificate for localhost, made with openssl (null where there is none). */
function selfSigned(): { key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(join(tmpdir(), "jenai-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const tlsPair = selfSigned();

describe("the SIP server, as this server's Asterisk sees it", () => {
  const ready = facts({ carrier: true, operstate: "up", ipv4: ["192.168.1.83"] });
  const cfg = { iface: "enp2s0", sipPeer: "192.168.1.34", gatewayHealthUrl: null, asteriskStatusFile: "/var/lib/jenai/line-status" };
  const at = (view: string, now = 1_800_000_000) => checkLine(cfg, ready, { sip: noSip, gateway: async () => true, asterisk: async () => parseAsteriskStatus(`at=1800000000\n${view}`) }, now * 1000).then((l) => l.checks.find((c) => c.key === "telecom"));

  it("is read from the file when one is named, and the SIP server is never probed from here", async () => {
    expect(lineConfigFromEnv({ JENAI_TEL_IFACE: "enp5s0", JENAI_TEL_ASTERISK_STATUS: "/var/lib/jenai/line-status" })).toMatchObject({ asteriskStatusFile: "/var/lib/jenai/line-status" });
    expect(await at("asterisk=up\nuser=1007\nregister=Registered\ngov=Avail\nvoice=Avail")).toMatchObject({ state: "ok", detail: "1007 signed in to 192.168.1.34 (through Asterisk)." });
  });

  it("says when the extension is not signed in, Asterisk is down, or the report is old", async () => {
    expect(await at("asterisk=up\nuser=1007\nregister=Rejected")).toMatchObject({ state: "fail", detail: "1007 is not signed in to 192.168.1.34 (Rejected).", fix: expect.stringMatching(/1007's password/) });
    expect(await at("asterisk=down\nuser=1007")).toMatchObject({ state: "fail", detail: "Asterisk on this server is not running." });
    expect(await at("asterisk=up\nuser=1007\nregister=Registered", 1_800_000_000 + 600)).toMatchObject({ state: "fail", detail: expect.stringMatching(/not reported/) });
    expect(await at("asterisk=up\ngov=Avail")).toMatchObject({ state: "ok", detail: "192.168.1.34 answers Asterisk on this server." });
    expect(parseAsteriskStatus("garbage")).toBeNull();
  });
});

describe("the telephone gateway check", () => {
  it.skipIf(!tlsPair)("finds an encrypted SIP port up when its TLS handshake completes (this server's own certificate accepted), and down when nothing listens", async () => {
    const server = createTlsServer({ ...tlsPair! }, (socket) => socket.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    expect(await gatewayUp(`tls://127.0.0.1:${port}`)).toBe(true);
    expect(await gatewayUp(`tls://localhost:${port}`)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await gatewayUp(`tls://127.0.0.1:${port}`, 1000)).toBe(false);
  });

  it("is up only when every gateway address answers, and names the one that does not", async () => {
    const cfg = { iface: "enp2s0", sipPeer: null, gatewayHealthUrl: "tls://127.0.0.1:5061,tls://voice.example.in:5061" };
    const ready = facts({ carrier: true, operstate: "up", ipv4: ["10.1.2.3"] });
    const up = await checkLine(cfg, ready, { sip: noSip, gateway: async () => true });
    expect(up.checks.find((c) => c.key === "gateway")).toMatchObject({ state: "ok", detail: "Running." });
    const cloudDown = await checkLine(cfg, ready, { sip: noSip, gateway: async (u) => !u.includes("voice.example.in") });
    expect(cloudDown.checks.find((c) => c.key === "gateway")).toMatchObject({ state: "fail", detail: "voice.example.in:5061 is not answering.", fix: expect.stringMatching(/security group/) });
    const bothDown = await checkLine(cfg, ready, { sip: noSip, gateway: async () => false });
    expect(bothDown.checks.find((c) => c.key === "gateway")).toMatchObject({ detail: "Asterisk on this server and voice.example.in:5061 are not answering." });
    const localDown = await checkLine(cfg, ready, { sip: noSip, gateway: async (u) => u.includes("voice.example.in") });
    expect(localDown.checks.find((c) => c.key === "gateway")).toMatchObject({ detail: "Asterisk on this server is not answering.", fix: expect.stringMatching(/sip-bridge-setup\.sh/) });
  });

  it("finds Asterisk up when its port takes a connection, and down when nothing listens", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    expect(await gatewayUp(`tcp://127.0.0.1:${port}`)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await gatewayUp(`tcp://127.0.0.1:${port}`, 1000)).toBe(false);
  });
});

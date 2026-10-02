/** The government telephone line checks, with made-up network facts and a local stand-in SIP system. */
import { describe, expect, it } from "vitest";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { checkLine, lineConfigFromEnv, pickPort, sipOptions, type NetFacts } from "./telephone-line";

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
    peer.on("message", (msg, rinfo) => {
      const text = msg.toString("latin1");
      const callId = /Call-ID: (.+)\r\n/.exec(text)![1];
      peer.send(`SIP/2.0 200 OK\r\nCall-ID: ${callId}\r\nContent-Length: 0\r\n\r\n`, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", () => r()));
    const at = `127.0.0.1:${(peer.address() as AddressInfo).port}`;
    const r = await sipOptions(at, 2000);
    expect(r).toMatchObject({ ok: true, status: 200 });
    const line = await checkLine({ iface: "enp2s0", sipPeer: at, gatewayHealthUrl: null }, facts({ carrier: true, operstate: "up", ipv4: ["10.1.2.3"] }), { sip: sipOptions, gateway: async () => false });
    expect(line.checks.find((c) => c.key === "telecom")).toMatchObject({ state: "ok", detail: expect.stringMatching(/answered in \d+ ms \(SIP 200\)/) });
    peer.close();
    const silent = await sipOptions("127.0.0.1:9", 500);
    expect(silent.ok).toBe(false);
    expect(await sipOptions("not an address:99999")).toMatchObject({ ok: false });
  });
});

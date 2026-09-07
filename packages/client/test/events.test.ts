import { describe, expect, test } from "bun:test";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { DocumentType, EventSchema } from "@fp-pcb/proto";
import { KiCadEvents, decodeEvent } from "../src/events";
import { NngIpcSubscriber } from "../src/transport";
import { startFakePubServer } from "./fake-pub-server";

function eventBytes(sequence: bigint, kind: MessageInitShape<typeof EventSchema>["kind"]): Uint8Array {
  return toBinary(EventSchema, create(EventSchema, { sequence, kind }));
}

describe("KiCadEvents", () => {
  test("decodes frames, dispatches by kind, tracks sequence and gaps", () => {
    const ev = new KiCadEvents();
    const changed: bigint[] = [];
    const all: string[] = [];
    const gaps: [bigint, bigint][] = [];
    ev.on("documentChanged", (p) => changed.push(p.revision));
    ev.on("*", (_p, e) => all.push(e.kind.case ?? "?"));
    ev.onGap((g) => gaps.push([g.expected, g.received]));

    ev.push(eventBytes(1n, { case: "documentOpened", value: { document: { type: DocumentType.DOCTYPE_PCB } } }));
    ev.push(eventBytes(2n, { case: "documentChanged", value: { revision: 7n, message: "move" } }));
    ev.push(eventBytes(5n, { case: "serverShutdown", value: {} }));

    expect(changed).toEqual([7n]);
    expect(all).toEqual(["documentOpened", "documentChanged", "serverShutdown"]);
    expect(gaps).toEqual([[2n, 5n]]);
    expect(ev.lastSequence).toBe(5n);
    expect(ev.received).toBe(3);
    expect(decodeEvent(eventBytes(9n, { case: "jobProgress", value: { percent: 50 } })).kind.value).toMatchObject({ percent: 50 });
  });

  test("undecodable frames go to onError, next() resolves with a filter and rejects on timeout", async () => {
    const ev = new KiCadEvents();
    const errors: Error[] = [];
    ev.onError((e) => errors.push(e));
    ev.push(Uint8Array.from([0xff, 0xff, 0xff]));
    expect(errors.length).toBe(1);

    const p = ev.next("documentSaved", { filter: (s) => s.path.endsWith(".kicad_pcb"), timeoutMs: 1000 });
    ev.push(eventBytes(1n, { case: "documentSaved", value: { path: "/a.kicad_sch" } }));
    ev.push(eventBytes(2n, { case: "documentSaved", value: { path: "/b.kicad_pcb" } }));
    expect((await p).path).toBe("/b.kicad_pcb");
    await expect(ev.next("jobProgress", { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  test("NngIpcSubscriber: SUB0 handshake, frames delivered in order, peer close -> closed", async () => {
    const pub = await startFakePubServer();
    const sub = await NngIpcSubscriber.connect({ path: `ipc://${pub.path}` });
    expect(sub.state).toBe("open");
    expect(pub.subscribers).toBe(1);
    const ev = new KiCadEvents(sub);
    const seen: bigint[] = [];
    ev.on("*", (_p, e) => seen.push(e.sequence));
    const done = ev.next("serverShutdown", { timeoutMs: 2000 });
    pub.publish(eventBytes(1n, { case: "documentOpened", value: {} }));
    pub.publish(eventBytes(2n, { case: "documentChanged", value: { revision: 1n } }));
    pub.publish(eventBytes(3n, { case: "serverShutdown", value: {} }));
    await done;
    expect(seen).toEqual([1n, 2n, 3n]);

    const closed = new Promise<string>((r) => sub.onStateChange((s, err) => s === "closed" && r(err?.message ?? "")));
    pub.dropAll();
    expect(await closed).toMatch(/closed|ended/);
    await ev.close();
    await pub.stop();
  });

  test("NngIpcSubscriber: rejects a peer that is not PUB0 and a missing socket", async () => {
    const wrong = await startFakePubServer({ handshakeProto: 0x31 });
    await expect(NngIpcSubscriber.connect({ path: wrong.path })).rejects.toThrow(/expected 0x20/);
    await wrong.stop();
    await expect(NngIpcSubscriber.connect({ path: "/tmp/kicad/does-not-exist.sock", connectTimeoutMs: 500 })).rejects.toThrow(/connect/);
  });

  test("NngIpcSubscriber: reconnects after the publisher restarts", async () => {
    const pub = await startFakePubServer();
    const sub = await NngIpcSubscriber.connect({ path: pub.path, reconnect: { initialDelayMs: 20, maxDelayMs: 50 } });
    const states: string[] = [];
    sub.onStateChange((s) => states.push(s));
    await pub.stop();
    const pub2 = await startFakePubServer({ path: pub.path });
    await sub.ready();
    expect(states).toEqual(["connecting", "open"]);
    const ev = new KiCadEvents(sub);
    const next = ev.next("jobProgress", { timeoutMs: 2000 });
    pub2.publish(eventBytes(1n, { case: "jobProgress", value: { percent: 100, finished: true } }));
    expect((await next).finished).toBe(true);
    await ev.close();
    await pub2.stop();
  });
});
